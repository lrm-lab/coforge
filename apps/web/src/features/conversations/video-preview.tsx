import { useCallback, useEffect, useRef, useState } from "react";
import { ClockPlus } from "@untitledui/icons";
import { Button } from "#src/components/base/buttons/button";
import { useBreakpoint } from "#src/hooks/use-breakpoint";
import { m } from "#src/paraglide/messages";
import type { Anchoring } from "./attachment-anchoring";
import { videoTimeLabel, type AttachmentCommentAnchor } from "./attachment-comment-anchors";
import { joinExclusivePlayback } from "./inline-video-exclusive";
import { resumeAt, type VideoPlace, type VideoStart } from "./video-handoff";

/** The events after which the video's paused state or time may read differently. */
const PLAYBACK_EVENTS = ["loadedmetadata", "timeupdate", "pause", "play", "seeked", "ended"];

/**
 * A video attachment in its preview, commented on at a time, as on Raft's page (1.0.53). With the
 * comments beside it, pausing (or seeking while paused) puts the time on the next comment; once
 * that time is removed, a paused video offers it back as a button. On a phone the comments cover
 * the video, so nothing is put on a comment unasked: the button is offered whenever the video is
 * paused, and opens the comments with the time on. A comment's time seeks the video there.
 */
export function VideoPreview({
  fileName,
  src,
  onError,
  anchoring,
  commentsOpen,
  pendingAnchor,
  videoStart,
  onVideoPlace,
}: {
  fileName: string;
  src: string;
  onError: () => void;
  anchoring?: Anchoring;
  commentsOpen?: boolean;
  pendingAnchor?: AttachmentCommentAnchor | null;
  /** Where the message's player was: the preview carries on from there (`VideoHandoff`). */
  videoStart?: VideoStart;
  /** Hears the preview's place as it moves, for the message's player to carry on from. */
  onVideoPlace?: (place: VideoPlace) => void;
}) {
  const video = useRef<HTMLVideoElement | null>(null);
  // Read when the element arrives and as it plays, not again on each render.
  const handoff = useRef({ videoStart, onVideoPlace });
  handoff.current.onVideoPlace = onVideoPlace;
  const [playback, setPlayback] = useState({ paused: true, time: 0 });
  const beside = useBreakpoint("lg");
  const commenting = Boolean(anchoring && commentsOpen && beside);
  const attach = useCallback(() => {
    const element = video.current;
    if (!element || !anchoring) return;
    // To the millisecond, as Raft stores it; the very start is the whole video.
    const time = Math.round(element.currentTime * 1000) / 1000;
    if (time > 0) anchoring.onComment({ type: "video-timestamp", data: { time } });
  }, [anchoring]);
  // The ref joins the page's one-video playback and follows what the controls do.
  const ref = useCallback((element: HTMLVideoElement | null) => {
    video.current = element;
    if (!element) return;
    const leave = joinExclusivePlayback(element);
    const start = handoff.current.videoStart?.place;
    if (start) resumeAt(element, start);
    const read = () => {
      const paused = element.paused || element.ended;
      setPlayback({ paused, time: element.currentTime });
      handoff.current.onVideoPlace?.({ time: element.currentTime, playing: !paused });
    };
    for (const type of PLAYBACK_EVENTS) element.addEventListener(type, read);
    return () => {
      for (const type of PLAYBACK_EVENTS) element.removeEventListener(type, read);
      leave();
      video.current = null;
    };
  }, []);
  useEffect(() => {
    const element = video.current;
    if (!element || !commenting) return;
    const seeked = () => {
      if (element.paused && element.currentTime > 0) attach();
    };
    element.addEventListener("pause", attach);
    element.addEventListener("seeked", seeked);
    return () => {
      element.removeEventListener("pause", attach);
      element.removeEventListener("seeked", seeked);
    };
  }, [commenting, attach]);
  useEffect(() => {
    if (!anchoring) return;
    anchoring.onSurface({
      // Comments on a time list in the video's order; one past its end is still a time.
      locate: (anchor) => (anchor.type === "video-timestamp" ? anchor.data.time : null),
      jump(anchor) {
        const element = video.current;
        if (anchor.type !== "video-timestamp" || !element) return;
        element.pause();
        element.currentTime = anchor.data.time;
      },
    });
    return () => anchoring.onSurface(null);
  }, [anchoring]);
  const offered =
    Boolean(anchoring) &&
    (commenting || !beside) &&
    playback.paused &&
    playback.time > 0 &&
    pendingAnchor?.type !== "video-timestamp";
  return (
    <div className="relative flex min-h-0 flex-1 items-center justify-center bg-black/90 p-4">
      <video
        ref={ref}
        src={src}
        controls
        playsInline
        preload="metadata"
        className="max-h-full max-w-full"
        aria-label={fileName}
        onError={onError}
      />
      {offered && (
        // Above the player's own controls, which a paused video shows.
        <Button
          size="md"
          color="secondary"
          iconLeading={ClockPlus}
          className="absolute inset-x-0 bottom-20 mx-auto w-fit"
          onPress={attach}
        >
          {m.attachment_comments_add_timestamp({ time: videoTimeLabel(playback.time) })}
        </Button>
      )}
    </div>
  );
}
