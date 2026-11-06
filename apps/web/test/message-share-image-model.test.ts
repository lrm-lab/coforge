import { expect, test } from "bun:test";

import {
  SHARE_CARD_WIDE_WIDTH,
  SHARE_CARD_WIDTH,
  SHARE_CANVAS_MAX_AREA,
  SHARE_CANVAS_MAX_SIDE,
  SHARE_IMAGE_SCALE,
  shareFileName,
  shareImageScale,
  sharePageMaxHeight,
  sharePages,
} from "#src/features/conversations/message-share-image-model";

const SHARE_PAGE_MAX_HEIGHT = 960;

test("a wider image holds a taller run of messages", () => {
  expect(sharePageMaxHeight(SHARE_CARD_WIDTH)).toBe(960);
  expect(sharePageMaxHeight(SHARE_CARD_WIDE_WIDTH)).toBe(1440);
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
  // Near the limit, not far under it: as sharp as it can be.
  expect(720 * scale * (30_000 * scale)).toBeGreaterThan(SHARE_CANVAS_MAX_AREA * 0.99);
});

test("a narrow, extremely tall one also keeps to the longest side", () => {
  const scale = shareImageScale(480, 200_000);
  expect(200_000 * scale).toBeLessThanOrEqual(SHARE_CANVAS_MAX_SIDE);
  expect(480 * scale * (200_000 * scale)).toBeLessThanOrEqual(SHARE_CANVAS_MAX_AREA);
});
