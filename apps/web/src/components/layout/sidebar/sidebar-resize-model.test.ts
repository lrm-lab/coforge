import { describe, expect, test } from "bun:test";
import {
  SIDEBAR_COLLAPSE_THRESHOLD_REM,
  SIDEBAR_EXPAND_THRESHOLD_REM,
  SIDEBAR_RAIL_REM,
  beginSidebarDrag,
  finishSidebarDrag,
  keySidebarResize,
  stepSidebarDrag,
} from "./sidebar-resize-model";

const key = (
  k: string,
  extra: Partial<{ shiftKey: boolean; metaKey: boolean; ctrlKey: boolean; altKey: boolean }> = {},
) => ({
  key: k,
  shiftKey: false,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  ...extra,
});

describe("sidebar drag-to-collapse model", () => {
  test("resizes continuously down to 10rem and snaps to rail below 10rem without clobbering remembered width", () => {
    let state = beginSidebarDrag({
      collapsed: false,
      currentWidth: 15,
      rememberedWidth: 15,
      startX: 15,
      rtl: false,
    });

    let step = stepSidebarDrag(state, 12);
    state = step.state;
    expect(step.collapsed).toBe(false);
    expect(step.width).toBe(12);
    expect(step.snapPrimed).toBe(false);

    step = stepSidebarDrag(state, 10.5);
    state = step.state;
    expect(step.collapsed).toBe(false);
    expect(step.width).toBe(10.5);
    expect(step.snapPrimed).toBe(true);

    step = stepSidebarDrag(state, SIDEBAR_COLLAPSE_THRESHOLD_REM - 0.5);
    state = step.state;
    expect(step.collapsed).toBe(true);
    expect(step.collapsedChanged).toBe(true);
    expect(step.width).toBe(SIDEBAR_RAIL_REM);

    step = stepSidebarDrag(state, 8.5);
    state = step.state;
    expect(step.collapsed).toBe(true);
    expect(step.collapsedChanged).toBe(false);

    step = stepSidebarDrag(state, 6);
    state = step.state;
    expect(step.collapsed).toBe(true);

    const done = finishSidebarDrag(state);
    expect(done.collapsed).toBe(true);
    expect(done.commitWidth).toBeUndefined();
    expect(done.restoreWidth).toBe(15);
  });

  test("preserves custom expanded width when sweeping past threshold to collapse, and commits when released expanded", () => {
    let state = beginSidebarDrag({
      collapsed: false,
      currentWidth: 18,
      rememberedWidth: 18,
      startX: 18,
      rtl: false,
    });

    state = stepSidebarDrag(state, 13).state;
    const expandedDone = finishSidebarDrag(state);
    expect(expandedDone.collapsed).toBe(false);
    expect(expandedDone.commitWidth).toBe(13);

    state = stepSidebarDrag(state, 9).state;
    const collapsedDone = finishSidebarDrag(state);
    expect(collapsedDone.collapsed).toBe(true);
    expect(collapsedDone.commitWidth).toBeUndefined();
    expect(collapsedDone.restoreWidth).toBe(18);
  });

  test("re-expands during same drag only past hysteresis above collapse threshold", () => {
    let state = beginSidebarDrag({
      collapsed: false,
      currentWidth: 15,
      rememberedWidth: 15,
      startX: 15,
      rtl: false,
    });

    state = stepSidebarDrag(state, 9.5).state;
    expect(state.collapsed).toBe(true);

    let step = stepSidebarDrag(state, 10.5);
    state = step.state;
    expect(step.collapsed).toBe(true);

    step = stepSidebarDrag(state, 11.2);
    state = step.state;
    expect(step.collapsed).toBe(false);
    expect(step.collapsedChanged).toBe(true);
    expect(step.width).toBe(11.2);
  });

  test("drags right from collapsed rail past expand threshold to restore remembered width without flip-flop", () => {
    let state = beginSidebarDrag({
      collapsed: true,
      currentWidth: SIDEBAR_RAIL_REM,
      rememberedWidth: 16.5,
      startX: SIDEBAR_RAIL_REM,
      rtl: false,
    });

    let step = stepSidebarDrag(state, SIDEBAR_EXPAND_THRESHOLD_REM - 0.25);
    state = step.state;
    expect(step.collapsed).toBe(true);
    expect(step.collapsedChanged).toBe(false);

    step = stepSidebarDrag(state, SIDEBAR_EXPAND_THRESHOLD_REM + 0.5);
    state = step.state;
    expect(step.collapsed).toBe(false);
    expect(step.collapsedChanged).toBe(true);
    expect(step.width).toBe(16.5);

    step = stepSidebarDrag(state, 9.5);
    state = step.state;
    expect(step.collapsed).toBe(false);
    expect(step.width).toBe(16.5);

    const done = finishSidebarDrag(state);
    expect(done.collapsed).toBe(false);
    expect(done.commitWidth).toBeUndefined();
  });

  test("catches up to live resizing if user keeps dragging past remembered width from rail", () => {
    let state = beginSidebarDrag({
      collapsed: true,
      currentWidth: SIDEBAR_RAIL_REM,
      rememberedWidth: 15,
      startX: SIDEBAR_RAIL_REM,
      rtl: false,
    });

    state = stepSidebarDrag(state, 8).state;
    expect(state.collapsed).toBe(false);
    expect(state.width).toBe(15);

    state = stepSidebarDrag(state, 15).state;
    const step = stepSidebarDrag(state, 17.5);
    state = step.state;
    expect(step.collapsed).toBe(false);
    expect(step.width).toBe(17.5);

    const done = finishSidebarDrag(state);
    expect(done.commitWidth).toBe(17.5);
  });

  test("mirrors drag directions in RTL", () => {
    let state = beginSidebarDrag({
      collapsed: false,
      currentWidth: 15,
      rememberedWidth: 15,
      startX: 20,
      rtl: true,
    });

    const shrunk = stepSidebarDrag(state, 26);
    expect(shrunk.collapsed).toBe(true);
    expect(shrunk.width).toBe(SIDEBAR_RAIL_REM);

    let railState = beginSidebarDrag({
      collapsed: true,
      currentWidth: SIDEBAR_RAIL_REM,
      rememberedWidth: 15,
      startX: 20,
      rtl: true,
    });
    const expanded = stepSidebarDrag(railState, 15);
    expect(expanded.collapsed).toBe(false);
    expect(expanded.width).toBe(15);
  });

  test("keyboard steps resize, collapse below 10rem, and expand from rail", () => {
    expect(
      keySidebarResize(key("ArrowLeft"), { collapsed: false, width: 15, rememberedWidth: 15 }),
    ).toEqual({
      collapsed: false,
      width: 14,
    });
    expect(
      keySidebarResize(key("ArrowLeft"), { collapsed: false, width: 10, rememberedWidth: 15 }),
    ).toEqual({
      collapsed: true,
    });
    expect(
      keySidebarResize(key("Home"), { collapsed: false, width: 15, rememberedWidth: 15 }),
    ).toEqual({
      collapsed: true,
    });
    expect(
      keySidebarResize(key("ArrowRight"), { collapsed: true, width: 3.5, rememberedWidth: 16 }),
    ).toEqual({
      collapsed: false,
      width: 16,
    });
    expect(
      keySidebarResize(key("End"), { collapsed: true, width: 3.5, rememberedWidth: 15 }),
    ).toEqual({
      collapsed: false,
      width: 20,
    });
    expect(
      keySidebarResize(key("ArrowLeft"), { collapsed: true, width: 3.5, rememberedWidth: 15 }),
    ).toBeUndefined();
    expect(
      keySidebarResize(key("ArrowLeft", { metaKey: true }), {
        collapsed: false,
        width: 15,
        rememberedWidth: 15,
      }),
    ).toBeUndefined();
  });
});
