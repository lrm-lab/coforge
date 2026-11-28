import { describe, expect, test } from "bun:test";
import {
  filterSweepOptions,
  findPaneHeaderMisalignments,
  isInsideViewportScroller,
  resolveHorizontalDividerRule,
} from "../scripts/ui-sweep-helpers.mjs";
import { buildSurfaces } from "../scripts/ui-sweep-surfaces.mjs";

describe("UI sweep viewport checks", () => {
  const style = (element: { overflowX?: string; textOverflow?: string }) => ({
    overflowX: element.overflowX ?? "visible",
    textOverflow: element.textOverflow ?? "clip",
  });

  test("exempts a descendant clipped by an in-viewport horizontal scroller", () => {
    const scroller = {
      overflowX: "auto",
      scrollWidth: 700,
      clientWidth: 300,
      parentElement: null,
      getBoundingClientRect: () => ({ left: 20, right: 320 }),
    };
    expect(isInsideViewportScroller({ parentElement: scroller }, 390, style)).toBe(true);
  });

  test("does not hide overflow when the scroller itself exceeds the viewport", () => {
    const scroller = {
      overflowX: "scroll",
      scrollWidth: 700,
      clientWidth: 430,
      parentElement: null,
      getBoundingClientRect: () => ({ left: 0, right: 430 }),
    };
    expect(isInsideViewportScroller({ parentElement: scroller }, 390, style)).toBe(false);
  });

  test("exempts an inline descendant clipped by an in-viewport ellipsis parent", () => {
    const truncated = {
      overflowX: "hidden",
      textOverflow: "ellipsis",
      scrollWidth: 500,
      clientWidth: 280,
      parentElement: null,
      getBoundingClientRect: () => ({ left: 88, right: 374 }),
    };
    expect(isInsideViewportScroller({ parentElement: truncated }, 390, style)).toBe(true);
  });

  test("does not exempt a descendant under overflowX hidden without ellipsis", () => {
    const clipped = {
      overflowX: "hidden",
      textOverflow: "clip",
      scrollWidth: 500,
      clientWidth: 280,
      parentElement: null,
      getBoundingClientRect: () => ({ left: 88, right: 374 }),
    };
    expect(isInsideViewportScroller({ parentElement: clipped }, 390, style)).toBe(false);
  });

  test("does not exempt a descendant when the ellipsis parent itself exceeds viewportWidth", () => {
    const truncatedTooWide = {
      overflowX: "hidden",
      textOverflow: "ellipsis",
      scrollWidth: 600,
      clientWidth: 430,
      parentElement: null,
      getBoundingClientRect: () => ({ left: 0, right: 430 }),
    };
    expect(isInsideViewportScroller({ parentElement: truncatedTooWide }, 390, style)).toBe(false);
  });

  test("filters themes and viewports by their environment names", () => {
    expect(filterSweepOptions(["light", "dark"], "dark", "theme")).toEqual(["dark"]);
    expect(filterSweepOptions([{ name: "390" }, { name: "1440" }], "390", "viewport")).toEqual([
      { name: "390" },
    ]);
  });
});

describe("findPaneHeaderMisalignments", () => {
  test("accepts clean aligned 3-pane desktop layout", () => {
    const findings = findPaneHeaderMisalignments(
      [
        {
          locator: "div.sidebar-top",
          left: 0,
          right: 240,
          top: 8,
          bottom: 56,
          totalHeight: 48,
          borderless: true,
          multilineMobile: false,
          row1HasDivider: false,
          row1Y: 56,
          hasSubbar: false,
          subbarTop: null,
          row2HasDivider: false,
          row2Y: null,
        },
        {
          locator: "header.list",
          left: 241,
          right: 529,
          top: 8,
          bottom: 56,
          totalHeight: 48,
          borderless: false,
          multilineMobile: false,
          row1HasDivider: true,
          row1Y: 56,
          hasSubbar: false,
          subbarTop: null,
          row2HasDivider: false,
          row2Y: null,
        },
        {
          locator: "header.tabbed",
          left: 530,
          right: 1050,
          top: 8,
          bottom: 92,
          totalHeight: 84,
          borderless: false,
          multilineMobile: false,
          row1HasDivider: true,
          row1Y: 56,
          hasSubbar: true,
          subbarTop: 56,
          row2HasDivider: true,
          row2Y: 92,
        },
        {
          locator: "header.agent-profile",
          left: 1051,
          right: 1432,
          top: 8,
          bottom: 56,
          totalHeight: 84,
          borderless: false,
          multilineMobile: false,
          row1HasDivider: true,
          row1Y: 56,
          hasSubbar: true,
          subbarTop: 56,
          row2HasDivider: true,
          row2Y: 92,
        },
      ],
      { viewportWidth: 1440, expectedHeaderHeight: 48, expectedSubbarHeight: 36 },
    );
    expect(findings).toEqual([]);
  });

  test("accepts clean aligned 390px coarse phone layout", () => {
    const findings = findPaneHeaderMisalignments(
      [
        {
          locator: "header.tabbed",
          left: 0,
          right: 390,
          top: 0,
          bottom: 92,
          totalHeight: 92,
          borderless: false,
          multilineMobile: false,
          row1HasDivider: true,
          row1Y: 48,
          hasSubbar: true,
          subbarTop: 48,
          row2HasDivider: true,
          row2Y: 92,
        },
      ],
      { viewportWidth: 390, expectedHeaderHeight: 48, expectedSubbarHeight: 44 },
    );
    expect(findings).toEqual([]);
  });

  test("flags missing Row 1 divider border on non-borderless header", () => {
    const findings = findPaneHeaderMisalignments(
      [
        {
          locator: "header.agent-profile",
          left: 1051,
          right: 1432,
          top: 8,
          bottom: 56,
          totalHeight: 84,
          borderless: false,
          multilineMobile: false,
          row1HasDivider: false,
          row1Y: 56,
          hasSubbar: true,
          subbarTop: 56,
          row2HasDivider: true,
          row2Y: 92,
        },
      ],
      { viewportWidth: 1440, expectedHeaderHeight: 48, expectedSubbarHeight: 36 },
    );
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.every((f) => f.check === "pane-header-divider-misaligned")).toBe(true);
  });

  test("flags banner inserted between header and subbar", () => {
    const findings = findPaneHeaderMisalignments(
      [
        {
          locator: "header.tabbed",
          left: 346,
          right: 1062,
          top: 8,
          bottom: 92,
          totalHeight: 84,
          borderless: false,
          multilineMobile: false,
          row1HasDivider: true,
          row1Y: 56,
          hasSubbar: true,
          subbarTop: 56,
          row2HasDivider: true,
          row2Y: 92,
        },
        {
          locator: "header.echo-banner",
          left: 1063,
          right: 1432,
          top: 8,
          bottom: 56,
          totalHeight: 145,
          borderless: false,
          multilineMobile: false,
          row1HasDivider: true,
          row1Y: 56,
          hasSubbar: true,
          subbarTop: 117,
          row2HasDivider: true,
          row2Y: 153,
        },
      ],
      { viewportWidth: 1440, expectedHeaderHeight: 48, expectedSubbarHeight: 36 },
    );
    expect(findings.length).toBeGreaterThanOrEqual(3);
    expect(findings.every((f) => f.check === "pane-header-divider-misaligned")).toBe(true);
  });

  test("flags TabbedHeader -1px regression next to aligned subbar", () => {
    const findings = findPaneHeaderMisalignments(
      [
        {
          locator: "header.tabbed-short",
          left: 346,
          right: 1062,
          top: 8,
          bottom: 91,
          totalHeight: 83,
          borderless: false,
          multilineMobile: false,
          row1HasDivider: true,
          row1Y: 56,
          hasSubbar: true,
          subbarTop: 55,
          row2HasDivider: true,
          row2Y: 91,
        },
        {
          locator: "header.agent-profile",
          left: 1063,
          right: 1432,
          top: 8,
          bottom: 56,
          totalHeight: 84,
          borderless: false,
          multilineMobile: false,
          row1HasDivider: true,
          row1Y: 56,
          hasSubbar: true,
          subbarTop: 56,
          row2HasDivider: true,
          row2Y: 92,
        },
      ],
      { viewportWidth: 1440, expectedHeaderHeight: 48, expectedSubbarHeight: 36 },
    );
    expect(findings.length).toBeGreaterThanOrEqual(2);
    expect(findings.every((f) => f.check === "pane-header-divider-misaligned")).toBe(true);
  });

  test("flags MembersPageHeading 53px subbar mismatch", () => {
    const findings = findPaneHeaderMisalignments(
      [
        {
          locator: "header.tabbed",
          left: 346,
          right: 1062,
          top: 8,
          bottom: 92,
          totalHeight: 84,
          borderless: false,
          multilineMobile: false,
          row1HasDivider: true,
          row1Y: 56,
          hasSubbar: true,
          subbarTop: 56,
          row2HasDivider: true,
          row2Y: 92,
        },
        {
          locator: "header.members-subhead",
          left: 1063,
          right: 1432,
          top: 8,
          bottom: 56,
          totalHeight: 101,
          borderless: false,
          multilineMobile: false,
          row1HasDivider: true,
          row1Y: 56,
          hasSubbar: true,
          subbarTop: 56,
          row2HasDivider: true,
          row2Y: 109,
        },
      ],
      { viewportWidth: 1440, expectedHeaderHeight: 48, expectedSubbarHeight: 36 },
    );
    expect(findings.length).toBeGreaterThanOrEqual(2);
    expect(findings.every((f) => f.check === "pane-header-divider-misaligned")).toBe(true);
  });

  test("flags missing Row 2 divider border on subbar", () => {
    const findings = findPaneHeaderMisalignments(
      [
        {
          locator: "header.missing-subbar-border",
          left: 1063,
          right: 1432,
          top: 8,
          bottom: 56,
          totalHeight: 84,
          borderless: false,
          multilineMobile: false,
          row1HasDivider: true,
          row1Y: 56,
          hasSubbar: true,
          subbarTop: 56,
          row2HasDivider: false,
          row2Y: 92,
        },
      ],
      { viewportWidth: 1440, expectedHeaderHeight: 48, expectedSubbarHeight: 36 },
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.check).toBe("pane-header-divider-misaligned");
  });

  test("checks 390px single-pane height and allows multilineMobile only below 640px", () => {
    const wrongPhone = findPaneHeaderMisalignments(
      [
        {
          locator: "header.mobile-tall",
          left: 0,
          right: 390,
          top: 0,
          bottom: 56,
          totalHeight: 56,
          borderless: false,
          multilineMobile: false,
          row1HasDivider: true,
          row1Y: 56,
          hasSubbar: false,
          subbarTop: null,
          row2HasDivider: false,
          row2Y: null,
        },
      ],
      { viewportWidth: 390, expectedHeaderHeight: 48, expectedSubbarHeight: 44 },
    );
    expect(wrongPhone).toHaveLength(1);
    expect(wrongPhone[0]?.check).toBe("pane-header-divider-misaligned");

    const exemptPhone = findPaneHeaderMisalignments(
      [
        {
          locator: "header.artifact-mobile",
          left: 0,
          right: 390,
          top: 0,
          bottom: 65,
          totalHeight: 65,
          borderless: false,
          multilineMobile: true,
          row1HasDivider: true,
          row1Y: 65,
          hasSubbar: false,
          subbarTop: null,
          row2HasDivider: false,
          row2Y: null,
        },
      ],
      { viewportWidth: 390, expectedHeaderHeight: 48, expectedSubbarHeight: 44 },
    );
    expect(exemptPhone).toEqual([]);

    const nonExemptDesktop = findPaneHeaderMisalignments(
      [
        {
          locator: "header.artifact-desktop",
          left: 346,
          right: 1432,
          top: 8,
          bottom: 73,
          totalHeight: 65,
          borderless: false,
          multilineMobile: true,
          row1HasDivider: true,
          row1Y: 73,
          hasSubbar: false,
          subbarTop: null,
          row2HasDivider: false,
          row2Y: null,
        },
      ],
      { viewportWidth: 1440, expectedHeaderHeight: 48, expectedSubbarHeight: 36 },
    );
    expect(nonExemptDesktop).toHaveLength(1);
    expect(nonExemptDesktop[0]?.check).toBe("pane-header-divider-misaligned");
  });

  test("does not pair vertically stacked non-adjacent headers", () => {
    const findings = findPaneHeaderMisalignments(
      [
        {
          locator: "header.projects",
          left: 241,
          right: 1432,
          top: 8,
          bottom: 56,
          totalHeight: 48,
          borderless: false,
          multilineMobile: false,
          row1HasDivider: true,
          row1Y: 56,
          hasSubbar: false,
          subbarTop: null,
          row2HasDivider: false,
          row2Y: null,
        },
        {
          locator: "div.task-detail",
          left: 980,
          right: 1432,
          top: 56,
          bottom: 104,
          totalHeight: 48,
          borderless: false,
          multilineMobile: false,
          row1HasDivider: true,
          row1Y: 104,
          hasSubbar: false,
          subbarTop: null,
          row2HasDivider: false,
          row2Y: null,
        },
      ],
      { viewportWidth: 1440, expectedHeaderHeight: 48, expectedSubbarHeight: 36 },
    );
    expect(findings).toEqual([]);
  });
});

describe("buildSurfaces multi-pane coverage", () => {
  test("includes all 5 multi-pane split surfaces when seeded ids exist", () => {
    const { surfaces } = buildSurfaces(
      {
        workspaceSlug: "dev",
        agentId: "a1",
        computerId: "c1",
        channelId: "ch1",
        dmId: "dm1",
        channelTaskNumber: "1",
      },
      { baseUrl: "http://127.0.0.1:8795", locale: "en" },
    );
    const byKey = new Map(surfaces.map((s) => [s.key, s]));
    expect(byKey.get("dm-agent-profile")?.url).toBe(
      "http://127.0.0.1:8795/en/w/dev/dm/dm1?profile=agent:a1",
    );
    expect(byKey.get("channel-settings-panel")?.url).toBe(
      "http://127.0.0.1:8795/en/w/dev/channel/ch1?details=panel",
    );
    expect(byKey.get("channel-settings-members")?.url).toBe(
      "http://127.0.0.1:8795/en/w/dev/channel/ch1?details=members",
    );
    expect(byKey.get("channel-task-split")?.url).toBe(
      "http://127.0.0.1:8795/en/w/dev/channel/ch1?task=1",
    );
    expect(byKey.get("activity-detail-split")?.url).toBe("http://127.0.0.1:8795/en/w/dev/activity");
  });

  test("uses channelTaskChannelId when provided for channel-task-split", () => {
    const { surfaces } = buildSurfaces(
      {
        workspaceSlug: "dev",
        agentId: "a1",
        computerId: "c1",
        channelId: "ch1",
        channelTaskChannelId: "ch2",
        channelTaskNumber: "4",
        dmId: "dm1",
      },
      { baseUrl: "http://127.0.0.1:8795", locale: "en" },
    );
    const byKey = new Map(surfaces.map((s) => [s.key, s]));
    expect(byKey.get("channel-task-split")?.url).toBe(
      "http://127.0.0.1:8795/en/w/dev/channel/ch2?task=4",
    );
  });
});

describe("resolveHorizontalDividerRule", () => {
  test("computes TabbedHeader internal ::before rule without misclassifying bottom edge", () => {
    const res = resolveHorizontalDividerRule(
      { top: 8, bottom: 92 },
      { borderBottomWidth: "1px", borderBottomColor: "rgb(224, 229, 241)" },
      {
        content: '""',
        display: "block",
        borderTopWidth: "1px",
        borderTopColor: "rgb(224, 229, 241)",
        borderBottomWidth: "0px",
        borderBottomColor: "rgb(0, 0, 0)",
        height: "0px",
        backgroundColor: "rgba(0, 0, 0, 0)",
        top: "47px",
        bottom: "auto",
      },
    );
    expect(res).toEqual({ hasBottomBorder: true, beforeRuleY: 56 });
  });

  test("resolves AgentProfileTabs bottom ::before rule even when Chromium resolves top offset", () => {
    const res = resolveHorizontalDividerRule(
      { top: 56, bottom: 92 },
      { borderBottomWidth: "0px", borderBottomColor: "rgb(0, 0, 0)" },
      {
        content: '""',
        display: "block",
        borderTopWidth: "0px",
        borderTopColor: "rgba(0, 0, 0, 0)",
        borderBottomWidth: "0px",
        borderBottomColor: "rgba(0, 0, 0, 0)",
        height: "1px",
        backgroundColor: "rgb(224, 229, 241)",
        top: "35px",
        bottom: "0px",
      },
    );
    expect(res).toEqual({ hasBottomBorder: false, beforeRuleY: 92 });
  });

  test("ignores transparent borders and backgrounds", () => {
    const res = resolveHorizontalDividerRule(
      { top: 8, bottom: 56 },
      { borderBottomWidth: "1px", borderBottomColor: "rgba(0, 0, 0, 0)" },
      {
        content: '""',
        display: "block",
        borderTopWidth: "1px",
        borderTopColor: "transparent",
        borderBottomWidth: "0px",
        borderBottomColor: "oklch(0.5 0.1 250 / 0)",
        height: "1px",
        backgroundColor: "oklch(0.5 0.1 250 / 0)",
        top: "47px",
        bottom: "auto",
      },
    );
    expect(res).toEqual({ hasBottomBorder: false, beforeRuleY: null });
  });
});
