import { expect, test } from "bun:test";

import { fitSidePanelWidth, MIN_SIDE_PANEL_WIDTH } from "./record-side-panel-width";

test("beside the document the panel keeps its width, within a floor and half the parent", () => {
  expect(fitSidePanelWidth(384, 1200, true)).toBe(384);
  expect(fitSidePanelWidth(900, 1200, true)).toBe(600);
  expect(fitSidePanelWidth(100, 1200, true)).toBe(MIN_SIDE_PANEL_WIDTH);
});

test("without the document beside it the panel fills its parent", () => {
  expect(fitSidePanelWidth(384, 390, false)).toBe(390);
  expect(fitSidePanelWidth(384, 768, false)).toBe(768);
});
