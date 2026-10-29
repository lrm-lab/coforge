import { useEffect, useEffectEvent, useRef, useState, type RefObject } from "react";

import { joinExclusivePlayback } from "./inline-video-exclusive";
import { inlineVideoErrorOutcome } from "./inline-video-playback";
import { InlineVideoSpinner } from "./inline-video-spinner";

/**
 * A message's video in the browser's own player, as on Raft: its controls give play, the time,
 * seeking, volume, speed, picture-in-picture and full screen, in the browser's language. It shows
 * its first frame and plays when the reader presses play; the page plays one video at a time
 * (`inline-video-exclusive.ts`). An error on `src` moves to `fallbackSrc` at the same moment,
 * playing on from where it was (an expired signed URL); one with nothing left to try goes to
 * `onFailed`, which replaces the player.
 */
export function InlineVideoPlayer({
  src,
  fallbackSrc,
  label,
  onSize,
  onFailed,
  videoRef,
}: {
  src: string;
  fallbackSrc?: string;
  label: string;
  onSize: (size: { width: number; height: number }) => void;
  onFailed: (outcome: "unsupported" | "failed") => void;
  /** The element, for the preview to take its place from (`VideoHandoff`). */
  videoRef?: RefObject<HTMLVideoElement | null>;
}) {
  const ownRef = useRef<HTMLVideoElement>(null);
  const video = videoRef ?? ownRef;
  const [onFallback, setOnFallback] = useState(false);
  const [shown, setShown] = useState(false);
  const metadataLoaded = useRef(false);
  // Where to pick up after a move to the fallback.
  const resume = useRef<{ time: number; playing: boolean } | null>(null);

  const onError = () => {
    const element = video.current;
    if (!element) return;
    const outcome = inlineVideoErrorOutcome({
      code: element.error?.code,
      hasFallback: fallbackSrc !== undefined && !onFallback,
      metadataLoaded: metadataLoaded.current,
      online: navigator.onLine,
    });
    if (outcome !== "fallback") return onFailed(outcome);
    resume.current = { time: element.currentTime, playing: !element.paused };
    // The fallback's own metadata decides whether a later error is the format's.
    metadataLoaded.current = false;
    setOnFallback(true);
  };

  const onLoadedMetadata = () => {
    const element = video.current;
    if (!element) return;
    metadataLoaded.current = true;
    // Its size is known: a phone's Safari loads no frame before play, so the spinner ends here.
    setShown(true);
    if (element.videoWidth > 0 && element.videoHeight > 0)
      onSize({ width: element.videoWidth, height: element.videoHeight });
    const pickUp = resume.current;
    if (!pickUp) return;
    resume.current = null;
    element.currentTime = pickUp.time;
    if (pickUp.playing) element.play().catch(() => {});
  };

  // A file the browser already holds can have its metadata, or its error, before
  // the events' listeners are attached: the element is checked once on mount.
  const catchUp = useEffectEvent((element: HTMLVideoElement) => {
    if (element.error) return onError();
    if (element.readyState >= HTMLMediaElement.HAVE_METADATA) onLoadedMetadata();
  });

  useEffect(() => {
    const element = video.current;
    if (!element) return;
    catchUp(element);
    return joinExclusivePlayback(element);
  }, []);

  return (
    <>
      <video
        ref={video}
        src={onFallback ? fallbackSrc : src}
        aria-label={label}
        controls
        playsInline
        preload="metadata"
        className="size-full object-contain"
        onError={onError}
        onLoadedMetadata={onLoadedMetadata}
      />
      {!shown && <InlineVideoSpinner />}
    </>
  );
}
