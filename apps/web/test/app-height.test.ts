import { describe, expect, test } from "bun:test";

import { appHeight, tallestHeightSeen, viewportShapeKey } from "#src/lib/app-height";

const IPHONE_SAFE_AREA_TOP_AND_BOTTOM = 59 + 34;
const IN_APP_BROWSER_BARS_LEFT_BEHIND = 135;
const PORTRAIT_HEIGHT = 932;

const reading = {
  measured: PORTRAIT_HEIGHT,
  installed: true,
  safeAreaTotal: IPHONE_SAFE_AREA_TOP_AND_BOTTOM,
  onScreenKeyboardMayBeUp: false,
  applied: undefined,
  tallestSeen: PORTRAIT_HEIGHT,
};

describe("appHeight", () => {
  test("a browser tab uses what it measures, since its toolbars legitimately grow and shrink", () => {
    expect(appHeight({ ...reading, installed: false, measured: 700, tallestSeen: 932 })).toBe(700);
  });

  test("an installed app with nothing recorded yet uses what it measures", () => {
    expect(appHeight({ ...reading, tallestSeen: undefined })).toBe(PORTRAIT_HEIGHT);
  });

  test("an installed app that comes back short by the in-app browser's bars uses its tallest height", () => {
    expect(
      appHeight({ ...reading, measured: PORTRAIT_HEIGHT - IN_APP_BROWSER_BARS_LEFT_BEHIND }),
    ).toBe(PORTRAIT_HEIGHT);
  });

  test("an installed app short by no more than the safe areas uses what it measures, because height readings legitimately differ by the safe areas (WebKit bug 254868)", () => {
    expect(
      appHeight({ ...reading, measured: PORTRAIT_HEIGHT - IPHONE_SAFE_AREA_TOP_AND_BOTTOM }),
    ).toBe(PORTRAIT_HEIGHT - IPHONE_SAFE_AREA_TOP_AND_BOTTOM);
  });

  test("an installed app whose safe areas read 0 still uses its tallest height when it comes back short", () => {
    expect(appHeight({ ...reading, safeAreaTotal: 0, measured: PORTRAIT_HEIGHT - 1 })).toBe(
      PORTRAIT_HEIGHT,
    );
  });

  test("the shell does not shrink when a focus or resize arrives while the on-screen keyboard may be up", () => {
    expect(
      appHeight({
        ...reading,
        installed: false,
        onScreenKeyboardMayBeUp: true,
        applied: PORTRAIT_HEIGHT,
        measured: 500,
      }),
    ).toBe(PORTRAIT_HEIGHT);
  });

  test("with the on-screen keyboard up, a taller measurement still applies", () => {
    expect(
      appHeight({
        ...reading,
        installed: false,
        onScreenKeyboardMayBeUp: true,
        applied: 500,
        measured: PORTRAIT_HEIGHT,
      }),
    ).toBe(PORTRAIT_HEIGHT);
  });
});

describe("tallestHeightSeen", () => {
  test("a wrong first record, taken while the app was already short, is corrected by the next normal measurement", () => {
    const first = tallestHeightSeen(undefined, PORTRAIT_HEIGHT - IN_APP_BROWSER_BARS_LEFT_BEHIND);
    expect(tallestHeightSeen(first, PORTRAIT_HEIGHT)).toBe(PORTRAIT_HEIGHT);
  });

  test("a short measurement never lowers what was recorded", () => {
    expect(tallestHeightSeen(PORTRAIT_HEIGHT, 500)).toBe(PORTRAIT_HEIGHT);
  });
});

describe("viewportShapeKey", () => {
  test("portrait and landscape, and different screens, are recorded apart", () => {
    expect(viewportShapeKey(false, 430)).not.toBe(viewportShapeKey(true, 430));
    expect(viewportShapeKey(false, 430)).not.toBe(viewportShapeKey(false, 393));
  });
});
