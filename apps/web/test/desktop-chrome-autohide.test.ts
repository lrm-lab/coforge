import { expect, test } from "bun:test";

import {
  DESKTOP_CHROME_AUTOHIDE_MS,
  desktopChromeAutoHides,
} from "#src/features/computers/desktop-chrome-autohide";

test("chrome auto-hides only in phone fake-landscape", () => {
  expect(desktopChromeAutoHides(true)).toBe(true);
  expect(desktopChromeAutoHides(false)).toBe(false);
});

test("chrome auto-hide delay is 2.5 seconds", () => {
  expect(DESKTOP_CHROME_AUTOHIDE_MS).toBe(2500);
});
