export const SHARE_CARD_WIDTH = 480;

export const SHARE_CARD_WIDE_WIDTH = 720;

const SHARE_PAGE_ASPECT = 2;

export function sharePageMaxHeight(width: number): number {
  return width * SHARE_PAGE_ASPECT;
}

export const SHARE_RATIOS = ["auto", "3:4", "1:1", "4:3", "16:9"] as const;
export type ShareRatio = (typeof SHARE_RATIOS)[number];

const SHARE_RATIO_SIZES = {
  "3:4": { width: 480, height: 640 },
  "1:1": { width: 600, height: 600 },
  "4:3": { width: 720, height: 540 },
  "16:9": { width: 800, height: 450 },
} as const;

export function shareRatioSize(ratio: ShareRatio): { width: number; height?: number } {
  return ratio === "auto" ? { width: SHARE_CARD_WIDTH } : SHARE_RATIO_SIZES[ratio];
}

export const SHARE_IMAGE_SCALE = 3;

export const SHARE_CANVAS_MAX_AREA = 16_777_216;
export const SHARE_CANVAS_MAX_SIDE = 32_767;

export function shareImageScale(width: number, height: number): number {
  return Math.min(
    SHARE_IMAGE_SCALE,
    Math.sqrt(SHARE_CANVAS_MAX_AREA / (width * height)),
    SHARE_CANVAS_MAX_SIDE / Math.max(width, height),
  );
}

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

export function shareFileName(index: number, total: number): string {
  if (total <= 1) return "coforge-messages.png";
  const number = String(index + 1).padStart(String(total).length, "0");
  return `coforge-messages-${number}.png`;
}

const DELIVERED_ATTACHMENT = /\/workspaces\/[^/]+\/attachments\/([0-9a-f-]{36})\//i;
const DELIVERED_AVATAR = /\/users\/([0-9a-f-]{36})\/avatars\//i;
const SITE_ATTACHMENT = /^\/api\/attachments\/([0-9a-f-]{36})(?:\?(?!download)|$)/i;

export function shareImageAddress(
  url: string,
  { siteOrigin, workspaceId }: { siteOrigin: string; workspaceId: string },
): string | undefined {
  if (url.startsWith(siteOrigin)) {
    const id = SITE_ATTACHMENT.exec(url.slice(siteOrigin.length))?.[1];
    return id && `/api/attachments/${id}?download`;
  }
  const attachment = DELIVERED_ATTACHMENT.exec(url)?.[1];
  if (attachment) return `/api/attachments/${attachment}?download`;
  const user = DELIVERED_AVATAR.exec(url)?.[1];
  return user && `/api/workspaces/${workspaceId}/users/${user}/avatar`;
}
