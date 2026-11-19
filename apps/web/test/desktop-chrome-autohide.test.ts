import { expect, test } from "bun:test";

import {
  DESKTOP_CHROME_AUTOHIDE_MS,
  desktopChromeAutoHides,
  desktopPhoneChromeInFab,
} from "#src/features/computers/desktop-chrome-autohide";

test("chrome auto-hides only in phone fake-landscape when the top bar is still used", () => {
  expect(desktopChromeAutoHides(true)).toBe(true);
  expect(desktopChromeAutoHides(false)).toBe(false);
});

test("phone maximized desktops keep shell actions in the iframe FAB instead of the top bar", () => {
  expect(desktopPhoneChromeInFab(true, true)).toBe(true);
  expect(desktopPhoneChromeInFab(true, false)).toBe(false);
  expect(desktopPhoneChromeInFab(false, true)).toBe(false);
});

test("chrome auto-hide delay is 2.5 seconds", () => {
  expect(DESKTOP_CHROME_AUTOHIDE_MS).toBe(2500);
});
