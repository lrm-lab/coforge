import { describe, expect, test } from "bun:test";

import { shouldStackTabbedHeader } from "#src/components/layout/tabbed-header";

describe("shouldStackTabbedHeader", () => {
  test("stacks narrow headers even before tabs width is measured", () => {
    expect(
      shouldStackTabbedHeader({
        headerWidth: 390,
        contentWidth: 358,
        tabsWidth: 0,
        actionsWidth: 0,
        hasActions: true,
      }),
    ).toBe(true);
  });

  test("keeps wide headers single-row when content fits and stacks when it overflows", () => {
    expect(
      shouldStackTabbedHeader({
        headerWidth: 720,
        contentWidth: 672,
        tabsWidth: 200,
        actionsWidth: 80,
        hasActions: true,
      }),
    ).toBe(false);
    expect(
      shouldStackTabbedHeader({
        headerWidth: 520,
        contentWidth: 472,
        tabsWidth: 320,
        actionsWidth: 100,
        hasActions: true,
      }),
    ).toBe(true);
  });

  test("returns false when header width is unmeasured", () => {
    expect(
      shouldStackTabbedHeader({
        headerWidth: 0,
        contentWidth: 0,
        tabsWidth: 0,
        actionsWidth: 0,
        hasActions: true,
      }),
    ).toBe(false);
  });
});
