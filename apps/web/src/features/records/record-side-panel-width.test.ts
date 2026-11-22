import { expect, test } from "bun:test";

import {
  canDockSidePanel,
  DEFAULT_SIDE_PANEL_WIDTH,
  fitSidePanelWidth,
  MIN_SIDE_PANEL_WIDTH,
  parseSidePanelWidth,
} from "./record-side-panel-width";

test("beside the document the panel keeps its rem width within a floor and half the parent", () => {
  expect(fitSidePanelWidth(24, 1200, true)).toBe(24);
  expect(fitSidePanelWidth(56.25, 1200, true)).toBe(37.5);
  expect(fitSidePanelWidth(6, 1200, true)).toBe(MIN_SIDE_PANEL_WIDTH);
});

test("without the document beside it the panel fills its parent in rem", () => {
  expect(fitSidePanelWidth(24, 390, false)).toBe(24.38);
  expect(fitSidePanelWidth(24, 768, false)).toBe(48);
});

test("matches the 37.5rem container split threshold at 100% and 200% root zoom", () => {
  expect(canDockSidePanel(599, true, 16)).toBe(false);
  expect(canDockSidePanel(600, true, 16)).toBe(true);
  expect(canDockSidePanel(960, true, 32)).toBe(false);
  expect(canDockSidePanel(1199, true, 32)).toBe(false);
  expect(canDockSidePanel(1200, true, 32)).toBe(true);
  expect(fitSidePanelWidth(24, 1280, true, 32)).toBe(20);
  expect(fitSidePanelWidth(24, 960, true, 32)).toBe(24);
  expect(fitSidePanelWidth(24, 640, true, 32)).toBe(20);
});

test("migrates legacy stored px widths to rem and clamps below the minimum", () => {
  expect(parseSidePanelWidth("384")).toBe(DEFAULT_SIDE_PANEL_WIDTH);
  expect(parseSidePanelWidth("280")).toBe(MIN_SIDE_PANEL_WIDTH);
  expect(parseSidePanelWidth("480")).toBe(30);
  expect(parseSidePanelWidth("22.5")).toBe(22.5);
  expect(parseSidePanelWidth("10")).toBe(MIN_SIDE_PANEL_WIDTH);
  expect(parseSidePanelWidth(null)).toBe(DEFAULT_SIDE_PANEL_WIDTH);
});
