export const SHARE_CARD_WIDTH = 480;

export const SHARE_CARD_WIDE_WIDTH = 720;

const SHARE_PAGE_ASPECT = 2;

export const SHARE_ZOOM_DEFAULT_SCALE = 1;
export const SHARE_ZOOM_MAX_SCALE = 3;
export const SHARE_ZOOM_STEP = 0.5;
export const SHARE_DOUBLE_CLICK_ZOOM_STEP = 1;
export const SHARE_OVERVIEW_MIN_SCALE = 0.15;
export const SHARE_OVERVIEW_THRESHOLD = 0.98;
export const SHARE_ZOOM_EPSILON = 0.02;

export function sharePageMaxHeight(width: number): number {
  return width * SHARE_PAGE_ASPECT;
}

export const SHARE_RATIOS = ["auto", "long", "3:4", "1:1", "4:3", "16:9"] as const;
export type ShareRatio = (typeof SHARE_RATIOS)[number];
export type ShareViewport = "desktop" | "phone";

const SHARE_RATIO_SIZES = {
  "3:4": { width: 480, height: 640 },
  "1:1": { width: 600, height: 600 },
  "4:3": { width: 720, height: 540 },
  "16:9": { width: 800, height: 450 },
} as const;

export function shareAutoWidth(viewport: ShareViewport): number {
  return viewport === "desktop" ? SHARE_CARD_WIDE_WIDTH : SHARE_CARD_WIDTH;
}

export function shareRatioSize(
  ratio: ShareRatio,
  viewport: ShareViewport = "phone",
): { width: number; height?: number } {
  return ratio === "auto" || ratio === "long"
    ? { width: shareAutoWidth(viewport) }
    : SHARE_RATIO_SIZES[ratio];
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

export function shareSplitPages(
  ratio: ShareRatio,
  heights: readonly number[],
  maxHeight: number,
): number[][] {
  if (ratio === "long") {
    return heights.length > 0 ? [heights.map((_, index) => index)] : [];
  }
  return sharePages(heights, maxHeight);
}

export function shouldOfferMergeLong(ratio: ShareRatio, pageCount: number): boolean {
  return ratio === "auto" && pageCount > 1;
}

export function shareOverviewScale(
  viewportWidth: number,
  viewportHeight: number,
  contentWidth: number,
  contentHeight: number,
): number {
  if (viewportWidth <= 0 || viewportHeight <= 0 || contentWidth <= 0 || contentHeight <= 0) {
    return SHARE_ZOOM_DEFAULT_SCALE;
  }
  if (contentHeight <= viewportHeight) return SHARE_ZOOM_DEFAULT_SCALE;
  const raw = Math.min(viewportWidth / contentWidth, viewportHeight / contentHeight);
  return Math.max(
    SHARE_OVERVIEW_MIN_SCALE,
    Math.min(SHARE_ZOOM_DEFAULT_SCALE, Number(raw.toFixed(3))),
  );
}

export function canShareOverview(overviewScale: number): boolean {
  return overviewScale < SHARE_OVERVIEW_THRESHOLD;
}

export function isShareOverviewActive(scale: number, overviewScale: number): boolean {
  return canShareOverview(overviewScale) && scale < SHARE_ZOOM_DEFAULT_SCALE - SHARE_ZOOM_EPSILON;
}

export function shareZoomStepTarget(
  scale: number,
  direction: "in" | "out",
  overviewScale: number,
): { mode: "reset" | "overview" | "scale"; scale: number } {
  if (direction === "in") {
    if (scale < SHARE_ZOOM_DEFAULT_SCALE - SHARE_ZOOM_EPSILON) {
      return { mode: "reset", scale: SHARE_ZOOM_DEFAULT_SCALE };
    }
    const nextStep =
      Math.floor((scale + SHARE_ZOOM_EPSILON) / SHARE_ZOOM_STEP + 1) * SHARE_ZOOM_STEP;
    return {
      mode: "scale",
      scale: Math.min(SHARE_ZOOM_MAX_SCALE, Math.round(nextStep * 100) / 100),
    };
  }
  if (scale > SHARE_ZOOM_DEFAULT_SCALE + SHARE_ZOOM_EPSILON) {
    const prevStep =
      Math.ceil((scale - SHARE_ZOOM_EPSILON) / SHARE_ZOOM_STEP - 1) * SHARE_ZOOM_STEP;
    if (prevStep <= SHARE_ZOOM_DEFAULT_SCALE + SHARE_ZOOM_EPSILON) {
      return { mode: "reset", scale: SHARE_ZOOM_DEFAULT_SCALE };
    }
    return {
      mode: "scale",
      scale: Math.max(SHARE_ZOOM_DEFAULT_SCALE, Math.round(prevStep * 100) / 100),
    };
  }
  if (canShareOverview(overviewScale)) {
    return { mode: "overview", scale: overviewScale };
  }
  return { mode: "reset", scale: SHARE_ZOOM_DEFAULT_SCALE };
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
