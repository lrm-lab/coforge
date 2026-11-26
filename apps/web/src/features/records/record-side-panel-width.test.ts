import { expect, test } from "bun:test";

import { canDockSidePanel } from "./record-side-panel-width";

test("matches the 37.5rem container split threshold at 100% and 200% root zoom", () => {
  expect(canDockSidePanel(599, true, 16)).toBe(false);
  expect(canDockSidePanel(600, true, 16)).toBe(true);
  expect(canDockSidePanel(960, true, 32)).toBe(false);
  expect(canDockSidePanel(1199, true, 32)).toBe(false);
  expect(canDockSidePanel(1200, true, 32)).toBe(true);
  expect(canDockSidePanel(1200, false, 16)).toBe(false);
});
