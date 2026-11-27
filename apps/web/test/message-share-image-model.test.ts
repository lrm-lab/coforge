import { expect, test } from "bun:test";

import {
  SHARE_CARD_WIDE_WIDTH,
  SHARE_CARD_WIDTH,
  SHARE_CANVAS_MAX_AREA,
  SHARE_CANVAS_MAX_SIDE,
  SHARE_IMAGE_SCALE,
  SHARE_RATIOS,
  SHARE_ZOOM_DEFAULT_SCALE,
  SHARE_ZOOM_MAX_SCALE,
  canShareOverview,
  isShareOverviewActive,
  shareAutoWidth,
  shareFileName,
  shareImageAddress,
  shareImageScale,
  shareOverviewScale,
  sharePageMaxHeight,
  sharePages,
  shareRatioSize,
  shareSplitPages,
  shareZoomStepTarget,
  shouldOfferMergeLong,
} from "#src/features/conversations/message-share-image-model";

const SHARE_PAGE_MAX_HEIGHT = 960;

test("a wider image holds a taller run of messages", () => {
  expect(sharePageMaxHeight(SHARE_CARD_WIDTH)).toBe(960);
  expect(sharePageMaxHeight(SHARE_CARD_WIDE_WIDTH)).toBe(1440);
});

test("auto and long widths follow the active viewport", () => {
  expect(shareAutoWidth("desktop")).toBe(SHARE_CARD_WIDE_WIDTH);
  expect(shareAutoWidth("phone")).toBe(SHARE_CARD_WIDTH);
  expect(shareRatioSize("auto", "desktop")).toEqual({ width: SHARE_CARD_WIDE_WIDTH });
  expect(shareRatioSize("long", "desktop")).toEqual({ width: SHARE_CARD_WIDE_WIDTH });
  expect(shareRatioSize("auto", "phone")).toEqual({ width: SHARE_CARD_WIDTH });
  expect(shareRatioSize("long", "phone")).toEqual({ width: SHARE_CARD_WIDTH });
});

test("messages that fit stay on one page, in order", () => {
  expect(sharePages([100, 200, 300], SHARE_PAGE_MAX_HEIGHT)).toEqual([[0, 1, 2]]);
});

test("a message that would overflow starts the next page", () => {
  const tall = SHARE_PAGE_MAX_HEIGHT / 2 + 10;
  expect(sharePages([tall, tall, tall], SHARE_PAGE_MAX_HEIGHT)).toEqual([[0], [1], [2]]);
  expect(sharePages([tall, 100, tall], SHARE_PAGE_MAX_HEIGHT)).toEqual([[0, 1], [2]]);
});

test("a message taller than a page has a page of its own, uncut", () => {
  expect(sharePages([100, SHARE_PAGE_MAX_HEIGHT * 3, 100], SHARE_PAGE_MAX_HEIGHT)).toEqual([
    [0],
    [1],
    [2],
  ]);
});

test("no messages make no pages", () => {
  expect(sharePages([], SHARE_PAGE_MAX_HEIGHT)).toEqual([]);
  expect(shareSplitPages("long", [], SHARE_PAGE_MAX_HEIGHT)).toEqual([]);
});

test("long mode keeps every message in one uncut page regardless of height", () => {
  expect(shareSplitPages("long", [500, 800, 900, 1200], SHARE_PAGE_MAX_HEIGHT)).toEqual([
    [0, 1, 2, 3],
  ]);
  expect(shareSplitPages("auto", [500, 800, 900], SHARE_PAGE_MAX_HEIGHT)).toEqual([[0], [1], [2]]);
  expect(shareSplitPages("3:4", [500, 800], 600)).toEqual([[0], [1]]);
});

test("merge-long button is offered only when auto splits into multiple pages", () => {
  expect(shouldOfferMergeLong("auto", 2)).toBe(true);
  expect(shouldOfferMergeLong("auto", 1)).toBe(false);
  expect(shouldOfferMergeLong("long", 2)).toBe(false);
  expect(shouldOfferMergeLong("3:4", 3)).toBe(false);
  expect(shouldOfferMergeLong("16:9", 3)).toBe(false);
});

test("overview scale computes contained fit only when image overflows stage height", () => {
  expect(shareOverviewScale(700, 600, 700, 500)).toBe(SHARE_ZOOM_DEFAULT_SCALE);
  expect(canShareOverview(1)).toBe(false);
  const longOverview = shareOverviewScale(720, 600, 720, 2400);
  expect(longOverview).toBe(0.25);
  expect(canShareOverview(longOverview)).toBe(true);
  expect(isShareOverviewActive(longOverview, longOverview)).toBe(true);
  expect(isShareOverviewActive(1, longOverview)).toBe(false);
  expect(shareOverviewScale(720, 600, 720, 60000)).toBe(0.15);
  expect(shareOverviewScale(0, 600, 720, 2400)).toBe(1);
});

test("zoom step targets transition cleanly between overview, 1x, and 300%", () => {
  const ov = 0.25;
  expect(shareZoomStepTarget(1, "out", ov)).toEqual({ mode: "overview", scale: ov });
  expect(shareZoomStepTarget(ov, "in", ov)).toEqual({ mode: "reset", scale: 1 });
  expect(shareZoomStepTarget(0.985, "in", ov)).toEqual({ mode: "scale", scale: 1.5 });
  expect(shareZoomStepTarget(1, "in", ov)).toEqual({ mode: "scale", scale: 1.5 });
  expect(shareZoomStepTarget(1.23, "in", ov)).toEqual({ mode: "scale", scale: 1.5 });
  expect(shareZoomStepTarget(1.5, "in", ov)).toEqual({ mode: "scale", scale: 2 });
  expect(shareZoomStepTarget(2.5, "in", ov)).toEqual({ mode: "scale", scale: 3 });
  expect(shareZoomStepTarget(3, "in", ov)).toEqual({ mode: "scale", scale: SHARE_ZOOM_MAX_SCALE });
  expect(shareZoomStepTarget(1.2, "out", ov)).toEqual({ mode: "reset", scale: 1 });
  expect(shareZoomStepTarget(1.5, "out", ov)).toEqual({ mode: "reset", scale: 1 });
  expect(shareZoomStepTarget(1.73, "out", ov)).toEqual({ mode: "scale", scale: 1.5 });
  expect(shareZoomStepTarget(2, "out", ov)).toEqual({ mode: "scale", scale: 1.5 });
  expect(shareZoomStepTarget(1, "out", 1)).toEqual({ mode: "reset", scale: 1 });
});

test("files are numbered only when there are several", () => {
  expect(shareFileName(0, 1)).toBe("coforge-messages.png");
  expect(shareFileName(1, 12)).toBe("coforge-messages-02.png");
});

test("an ordinary page is drawn at the full scale", () => {
  expect(shareImageScale(720, 1440)).toBe(SHARE_IMAGE_SCALE);
});

test("a very long message is scaled down until it fits Mobile Safari's canvas area", () => {
  const scale = shareImageScale(720, 30_000);
  expect(scale).toBeLessThan(SHARE_IMAGE_SCALE);
  expect(720 * scale * (30_000 * scale)).toBeLessThanOrEqual(SHARE_CANVAS_MAX_AREA);
  expect(720 * scale * (30_000 * scale)).toBeGreaterThan(SHARE_CANVAS_MAX_AREA * 0.99);
});

test("a narrow, extremely tall one also keeps to the longest side", () => {
  const scale = shareImageScale(480, 200_000);
  expect(200_000 * scale).toBeLessThanOrEqual(SHARE_CANVAS_MAX_SIDE);
  expect(480 * scale * (200_000 * scale)).toBeLessThanOrEqual(SHARE_CANVAS_MAX_AREA);
});

test("a CDN's attachment or avatar is read through this site, and nothing else is", () => {
  const at = { siteOrigin: "https://coforge.cn", workspaceId: "ws" };
  const id = "58fcf61c-3a8c-4756-9a8a-83945cfeee08";
  const attachment = `https://files.coforge.cn/workspaces/w/attachments/${id}/original?auth_key=1`;
  expect(shareImageAddress(attachment, at)).toBe(`/api/attachments/${id}?download`);
  const avatar = `https://images.coforge.cn/users/${id}/avatars/${id}/original?style=a`;
  expect(shareImageAddress(avatar, at)).toBe(`/api/workspaces/ws/users/${id}/avatar`);
  expect(shareImageAddress(`https://coforge.cn/api/attachments/${id}`, at)).toBe(
    `/api/attachments/${id}?download`,
  );
  for (const url of [
    `https://coforge.cn/api/attachments/${id}?download`,
    "https://coforge.cn/avatars/person-1-2.webp",
    "https://images.coforge.cn/projects/icon.webp",
  ])
    expect(shareImageAddress(url, at)).toBeUndefined();
});

test("a fixed ratio's size is that ratio, and auto leaves the height to its messages", () => {
  expect(shareRatioSize("auto", "phone")).toEqual({ width: SHARE_CARD_WIDTH });
  expect(shareRatioSize("auto", "desktop")).toEqual({ width: SHARE_CARD_WIDE_WIDTH });
  expect(shareRatioSize("long", "phone")).toEqual({ width: SHARE_CARD_WIDTH });
  for (const ratio of SHARE_RATIOS) {
    if (ratio === "auto" || ratio === "long") continue;
    const [across = 0, down = 0] = ratio.split(":").map(Number);
    const { width, height = 0 } = shareRatioSize(ratio);
    expect(width * down).toBe(height * across);
  }
});
