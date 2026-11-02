import { useRef, useState, type RefObject } from "react";

import { useMediaFallback, type MediaFailure } from "./inline-media";
import { InlineVideoSpinner } from "./inline-video-spinner";

/**
 * A message's video in the browser's own player, as on Raft: its controls give play, the time,
 * seeking, volume, speed, picture-in-picture and full screen, in the browser's language. It shows
 * its first frame and plays when the reader presses play; the page plays one video at a time
 * (`inline-video-exclusive.ts`). An error on `src` moves to `fallbackSrc`, playing on from where it
 * was, and one with nothing left to try goes to `onFailed`, which replaces the player
 * (`useMediaFallback`).
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
  onFailed: (outcome: MediaFailure) => void;
  /** The element, for the preview to take its place from (`VideoHandoff`). */
  videoRef?: RefObject<HTMLVideoElement | null>;
}) {
  const ownRef = useRef<HTMLVideoElement>(null);
  const video = videoRef ?? ownRef;
  const [shown, setShown] = useState(false);
  const playback = useMediaFallback({
    element: video,
    src,
    fallbackSrc,
    onFailed,
    onMetadata(element) {
      // Its size is known: a phone's Safari loads no frame before play, so the spinner ends here.
      setShown(true);
      if (element.videoWidth > 0 && element.videoHeight > 0)
        onSize({ width: element.videoWidth, height: element.videoHeight });
    },
  });

  return (
    <>
      <video
        ref={video}
        {...playback}
        aria-label={label}
        controls
        playsInline
        preload="metadata"
        className="size-full object-contain"
      />
      {!shown && <InlineVideoSpinner />}
    </>
  );
}
