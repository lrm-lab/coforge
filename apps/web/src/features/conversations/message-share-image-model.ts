/** Width of a share image, CSS pixels: on a phone it shows at about three quarters of its size. */
export const SHARE_CARD_WIDTH = 480;

/** Width of an image of more than fits the narrow one: a page holds more, in fewer pages. */
export const SHARE_CARD_WIDE_WIDTH = 720;

/** The tallest run of messages one image holds, its foot aside, as a share of its width. */
const SHARE_PAGE_ASPECT = 2;

/** The tallest run of messages an image of `width` holds. */
export function sharePageMaxHeight(width: number): number {
  return width * SHARE_PAGE_ASPECT;
}

/** The shapes an image comes in. "auto" is as tall as its messages, and as wide as they need. */
export const SHARE_RATIOS = ["auto", "3:4", "1:1", "4:3", "16:9"] as const;
export type ShareRatio = (typeof SHARE_RATIOS)[number];

const SHARE_RATIO_SIZES = {
  "3:4": { width: 480, height: 640 },
  "1:1": { width: 600, height: 600 },
  "4:3": { width: 720, height: 540 },
  "16:9": { width: 800, height: 450 },
} as const;

/** An image's CSS size: `height` is absent for "auto", and a fixed one is the card's least, since a
 * message taller than it stays whole. */
export function shareRatioSize(ratio: ShareRatio): { width: number; height?: number } {
  return ratio === "auto" ? { width: SHARE_CARD_WIDTH } : SHARE_RATIO_SIZES[ratio];
}

/** How many image pixels a CSS pixel becomes: sharp on any phone. */
export const SHARE_IMAGE_SCALE = 3;

/**
 * The largest canvas every browser draws, past which it draws nothing. Mobile Safari sets the area
 * (4,096 x 4,096) and Firefox the side:
 * https://jhildenbiddle.github.io/canvas-size/#/?id=test-results
 */
export const SHARE_CANVAS_MAX_AREA = 16_777_216;
export const SHARE_CANVAS_MAX_SIDE = 32_767;

/** The scale a card of this size is drawn at: the full one, or less for one too large for it. */
export function shareImageScale(width: number, height: number): number {
  return Math.min(
    SHARE_IMAGE_SCALE,
    Math.sqrt(SHARE_CANVAS_MAX_AREA / (width * height)),
    SHARE_CANVAS_MAX_SIDE / Math.max(width, height),
  );
}

/**
 * Selected messages as pages of indexes, in order: a page takes messages while they fit, and a
 * message that does not fit starts the next one. A message taller than a page is alone on its
 * page, whole, since a cut message misquotes its author.
 */
export function sharePages(heights: readonly number[], maxHeight: number): number[][] {
  const pages: number[][] = [];
  let room = 0;
  heights.forEach((height, index) => {
    const page = pages.at(-1);
    if (page && height <= room) page.push(index);
    else {
      pages.push([index]);
      room = maxHeight;
    }
    room -= height;
  });
  return pages;
}

/** One page's file name; numbered, to the width of the count, when there are several. */
export function shareFileName(index: number, total: number): string {
  if (total <= 1) return "coforge-messages.png";
  const number = String(index + 1).padStart(String(total).length, "0");
  return `coforge-messages-${number}.png`;
}

const DELIVERED_ATTACHMENT = /\/workspaces\/[^/]+\/attachments\/([0-9a-f-]{36})\//i;
const DELIVERED_AVATAR = /\/users\/([0-9a-f-]{36})\/avatars\//i;

/**
 * This site's own address for an image delivered from a CDN, whose address a capture cannot read:
 * neither the attachment nor the profile image CDN sends CORS headers. An attachment's `?download`
 * is the one form of its route that streams the bytes instead of redirecting back to the CDN.
 * Anything else keeps its address.
 */
export function shareImageAddress(
  url: string,
  { siteOrigin, workspaceId }: { siteOrigin: string; workspaceId: string },
): string | undefined {
  if (url.startsWith(siteOrigin)) return undefined;
  const attachment = DELIVERED_ATTACHMENT.exec(url)?.[1];
  if (attachment) return `/api/attachments/${attachment}?download`;
  const user = DELIVERED_AVATAR.exec(url)?.[1];
  return user && `/api/workspaces/${workspaceId}/users/${user}/avatar`;
}
