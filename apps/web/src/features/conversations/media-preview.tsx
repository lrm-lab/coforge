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

/** Comments on a time in a video or an audio file (`video-timestamp`, the one anchor type Raft has
 * for it; an audio file shares it). Pausing with the comments beside it (or seeking while paused)
 * puts the time on the next comment; once that time is removed, a paused player offers it back as
 * a button. On a phone the comments cover the player, so nothing is put on a comment unasked: the
 * button is offered whenever the player is paused, and opens the comments with the time on. A
 * comment's time seeks the player there. `track` is the player's ref callback. */
function useTimeComments<E extends HTMLMediaElement>({
  anchoring,
  commentsOpen,
  pendingAnchor,
  onPlayer,
}: {
  anchoring?: Anchoring;
  commentsOpen?: boolean;
  pendingAnchor?: AttachmentCommentAnchor | null;
  /** The player as it arrives, for what else follows it; returns its cleanup. */
  onPlayer?: (element: E) => (() => void) | void;
}) {
  const player = useRef<E | null>(null);
  const extra = useRef(onPlayer);
  extra.current = onPlayer;
  const [playback, setPlayback] = useState({ paused: true, time: 0 });
  const beside = useBreakpoint("lg");
  const commenting = Boolean(anchoring && commentsOpen && beside);
  const attach = useCallback(() => {
    const element = player.current;
    if (!element || !anchoring) return;
    // To the millisecond, as Raft stores it; the very start is the whole file.
    const time = Math.round(element.currentTime * 1000) / 1000;
    if (time > 0) anchoring.onComment({ type: "video-timestamp", data: { time } });
  }, [anchoring]);
  // Read when the element arrives and as it plays, not again on each render.
  const track = useCallback((element: E | null) => {
    player.current = element;
    if (!element) return;
    const read = () =>
      setPlayback({ paused: element.paused || element.ended, time: element.currentTime });
    const leave = extra.current?.(element);
    for (const type of PLAYBACK_EVENTS) element.addEventListener(type, read);
    return () => {
      for (const type of PLAYBACK_EVENTS) element.removeEventListener(type, read);
      leave?.();
      player.current = null;
    };
  }, []);
  useEffect(() => {
    const element = player.current;
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
      // Comments on a time list in the file's order; one past its end is still a time.
      locate: (anchor) => (anchor.type === "video-timestamp" ? anchor.data.time : null),
      jump(anchor) {
        const element = player.current;
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
  const offer = offered ? { time: playback.time, attach } : null;
  return { track, offer };
}

/** "Add Timestamp m:ss" for a paused player whose time is not on the comment yet. */
function AddTimestamp({
  offer,
  className,
}: {
  offer: { time: number; attach: () => void };
  className?: string;
}) {
  return (
    <Button
      size="md"
      color="secondary"
      iconLeading={ClockPlus}
      className={className}
      onPress={offer.attach}
    >
      {m.attachment_comments_add_timestamp({ time: videoTimeLabel(offer.time) })}
    </Button>
  );
}

/** A video attachment in its preview, commented on at a time, as on Raft's page (1.0.53). */
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
  const handoff = useRef({ videoStart, onVideoPlace });
  handoff.current.onVideoPlace = onVideoPlace;
  // The player joins the page's one-video playback and hands its place back as it moves.
  const { track, offer } = useTimeComments<HTMLVideoElement>({
    anchoring,
    commentsOpen,
    pendingAnchor,
    onPlayer(element) {
      const leave = joinExclusivePlayback(element);
      const start = handoff.current.videoStart?.place;
      if (start) resumeAt(element, start);
      const place = () =>
        handoff.current.onVideoPlace?.({
          time: element.currentTime,
          playing: !(element.paused || element.ended),
        });
      for (const type of PLAYBACK_EVENTS) element.addEventListener(type, place);
      return () => {
        for (const type of PLAYBACK_EVENTS) element.removeEventListener(type, place);
        leave();
      };
    },
  });
  return (
    <div className="relative flex min-h-0 flex-1 items-center justify-center bg-black/90 p-4">
      <video
        ref={track}
        src={src}
        controls
        playsInline
        preload="metadata"
        className="max-h-full max-w-full"
        aria-label={fileName}
        onError={onError}
      />
      {offer && (
        // Above the player's own controls, which a paused video shows.
        <AddTimestamp offer={offer} className="absolute inset-x-0 bottom-20 mx-auto w-fit" />
      )}
    </div>
  );
}

/** An audio attachment in its preview, commented on at a time like a video (task #281). The
 * button sits under the player, which is a single bar with no picture to float it over. */
export function AudioPreview({
  fileName,
  src,
  onError,
  anchoring,
  commentsOpen,
  pendingAnchor,
}: {
  fileName: string;
  src: string;
  onError: () => void;
  anchoring?: Anchoring;
  commentsOpen?: boolean;
  pendingAnchor?: AttachmentCommentAnchor | null;
}) {
  const { track, offer } = useTimeComments<HTMLAudioElement>({
    anchoring,
    commentsOpen,
    pendingAnchor,
  });
  return (
    <div className="flex flex-col items-center gap-4 p-4 sm:p-6">
      <audio
        ref={track}
        src={src}
        controls
        className="w-full"
        aria-label={fileName}
        onError={onError}
      />
      {offer && <AddTimestamp offer={offer} />}
    </div>
  );
}
