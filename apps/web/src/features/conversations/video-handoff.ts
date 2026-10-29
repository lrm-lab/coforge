/**
 * Where a video is, handed between its two players (task #284): the message's own and the
 * preview's. Expanding a video carries on from here in the preview, playing if it played, and
 * closing the preview carries the preview's place back, as Telegram does: the reader never starts
 * over. Both players stream the same signed URL (signed per window, `FILE_DELIVERY_URL_WINDOW_SECONDS`),
 * which the CDN serves as `private, max-age=1800`, so the browser reuses what it already read.
 */
export type VideoPlace = { time: number; playing: boolean };

/** A player's place, or nothing when it never left the start. */
export function placeOf(video: HTMLVideoElement): VideoPlace | undefined {
  const playing = !video.paused && !video.ended;
  return video.currentTime > 0 || playing ? { time: video.currentTime, playing } : undefined;
}

/** Puts `video` at `place`, once its length is known (a time before that is dropped). */
export function resumeAt(video: HTMLVideoElement, place: VideoPlace) {
  const apply = () => {
    video.currentTime = place.time;
    if (place.playing) video.play().catch(() => {});
    else video.pause();
  };
  if (video.readyState >= HTMLMediaElement.HAVE_METADATA) apply();
  else video.addEventListener("loadedmetadata", apply, { once: true });
}

/**
 * What the preview opens with: the message's player's place, and the file it already holds when
 * that is a copy in memory (no delivery: the whole file was read through the route). The preview
 * plays that copy rather than reading the file again; it is the message's to release, and the
 * preview, opened from the message, closes before it.
 */
export type VideoStart = { place?: VideoPlace; src?: string };

/** A video's two players: the message's `take`s its place as the preview opens (and pauses), and
 * `give`s it back the preview's as it closes. */
export type VideoHandoff = {
  take: () => VideoStart | undefined;
  give: (place: VideoPlace) => void;
};
