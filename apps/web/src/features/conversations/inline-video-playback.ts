import {
  MESSAGE_IMAGE_MAX_HEIGHT_PX,
  MESSAGE_IMAGE_MAX_WIDTH_PX,
  singleImageBox,
} from "#src/lib/attachment-image-box";

/** The narrowest a video is shown: its player's controls need the room. */
const INLINE_VIDEO_MIN_WIDTH_PX = 240;

/**
 * The box a message's video is shown in: a lone image's (`singleImageBox`) once the video's own
 * size is known, a 16:9 box as wide as a lone image's until then. A video that box would make
 * narrower than `INLINE_VIDEO_MIN_WIDTH_PX` (a phone's portrait clip) is widened to it, within
 * the image's height, and letterboxed.
 */
export function inlineVideoBox(size?: { width: number; height: number }) {
  if (!size) return { width: `min(${MESSAGE_IMAGE_MAX_WIDTH_PX}px, 100%)`, aspectRatio: "16 / 9" };
  const scale = Math.min(
    MESSAGE_IMAGE_MAX_WIDTH_PX / size.width,
    MESSAGE_IMAGE_MAX_HEIGHT_PX / size.height,
    1,
  );
  const width = size.width * scale;
  if (width >= INLINE_VIDEO_MIN_WIDTH_PX)
    return singleImageBox({ imageWidth: size.width, imageHeight: size.height });
  const height = Math.min(
    MESSAGE_IMAGE_MAX_HEIGHT_PX,
    Math.round((size.height * scale * INLINE_VIDEO_MIN_WIDTH_PX) / width),
  );
  return {
    width: `min(${INLINE_VIDEO_MIN_WIDTH_PX}px, 100%)`,
    aspectRatio: `${INLINE_VIDEO_MIN_WIDTH_PX} / ${height}`,
  };
}

/** `MediaError` codes (the DOM's constants, which the server render does not have). */
const MEDIA_ERR_DECODE = 3;
const MEDIA_ERR_SRC_NOT_SUPPORTED = 4;

/**
 * What a video's error leads to. A source with a fallback tries it first: an expired signed URL
 * fails exactly as a file the browser cannot read does (Chrome reports both as "source not
 * supported"), and the route's freshly signed URL tells them apart. With nothing left to try, a
 * file the browser could not read the start of while online is in a format it cannot play;
 * anything else (offline, or failing mid-way) is a load failure, which may be retried.
 */
export function inlineVideoErrorOutcome(state: {
  code: number | undefined;
  hasFallback: boolean;
  metadataLoaded: boolean;
  online: boolean;
}): "fallback" | "unsupported" | "failed" {
  if (state.hasFallback) return "fallback";
  const unreadable = state.code === MEDIA_ERR_SRC_NOT_SUPPORTED || state.code === MEDIA_ERR_DECODE;
  return unreadable && !state.metadataLoaded && state.online ? "unsupported" : "failed";
}
