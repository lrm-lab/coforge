import { describe, expect, test } from "bun:test";

import { shouldStackTabbedHeader } from "./tabbed-header";

describe("shouldStackTabbedHeader", () => {
  test("stays single-row when header meets minimum floor and identity, tabs, actions, and gaps fit", () => {
    expect(
      shouldStackTabbedHeader({
        headerWidth: 768,
        contentWidth: 720,
        tabsWidth: 196,
        actionsWidth: 286,
        hasActions: true,
      }),
    ).toBe(false);
  });

  test("stacks tabs onto the second row before tabs clip when side chat narrows the pane", () => {
    expect(
      shouldStackTabbedHeader({
        headerWidth: 580,
        contentWidth: 532,
        tabsWidth: 196,
        actionsWidth: 286,
        hasActions: true,
      }),
    ).toBe(true);
  });

  test("returns to single-row at the exact threshold width", () => {
    expect(
      shouldStackTabbedHeader({
        headerWidth: 689,
        contentWidth: 641,
        tabsWidth: 196,
        actionsWidth: 286,
        hasActions: true,
      }),
    ).toBe(true);
    expect(
      shouldStackTabbedHeader({
        headerWidth: 690,
        contentWidth: 642,
        tabsWidth: 196,
        actionsWidth: 286,
        hasActions: true,
      }),
    ).toBe(false);
  });

  test("preserves two-row stacking below 512px for narrow DMs and phones", () => {
    expect(
      shouldStackTabbedHeader({
        headerWidth: 511,
        contentWidth: 463,
        tabsWidth: 196,
        actionsWidth: 32,
        hasActions: true,
      }),
    ).toBe(true);
    expect(
      shouldStackTabbedHeader({
        headerWidth: 390,
        contentWidth: 358,
        tabsWidth: 196,
        actionsWidth: 32,
        hasActions: true,
      }),
    ).toBe(true);
  });

  test("keeps DM headers single-row at or above 512px when actions are narrow", () => {
    expect(
      shouldStackTabbedHeader({
        headerWidth: 512,
        contentWidth: 464,
        tabsWidth: 196,
        actionsWidth: 32,
        hasActions: true,
      }),
    ).toBe(false);
  });

  test("uses a single column gap when no actions are present", () => {
    expect(
      shouldStackTabbedHeader({
        headerWidth: 512,
        contentWidth: 464,
        tabsWidth: 324,
        actionsWidth: 0,
        hasActions: false,
      }),
    ).toBe(false);
    expect(
      shouldStackTabbedHeader({
        headerWidth: 512,
        contentWidth: 464,
        tabsWidth: 325,
        actionsWidth: 0,
        hasActions: false,
      }),
    ).toBe(true);
  });

  test("returns false when measurements are zero", () => {
    expect(
      shouldStackTabbedHeader({
        headerWidth: 0,
        contentWidth: 0,
        tabsWidth: 196,
        actionsWidth: 286,
        hasActions: true,
      }),
    ).toBe(false);
  });
});
