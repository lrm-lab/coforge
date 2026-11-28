import { describe, expect, test } from "bun:test";
import { hasCompleteDialogOverlay, isHiddenOffscreenLayer } from "../scripts/ui-sweep-helpers.mjs";
import { buildSurfaces } from "../scripts/ui-sweep-surfaces.mjs";
import { runSurfaceLoop } from "../scripts/ui-sweep.mjs";

describe("isHiddenOffscreenLayer", () => {
  const style = (element: { overflowX?: string }) => ({
    overflowX: element.overflowX ?? "visible",
  });

  test("exempts an inert element clipped inside an in-viewport overflow-hidden ancestor", () => {
    const scroller = {
      overflowX: "hidden",
      parentElement: null,
      getBoundingClientRect: () => ({ left: 0, right: 390 }),
    };
    const inertPane = {
      inert: true,
      parentElement: scroller,
    };
    expect(isHiddenOffscreenLayer({ parentElement: inertPane }, 390, style)).toBe(true);
  });

  test("exempts an aria-hidden element clipped inside an overflow-clip ancestor even with inner overflow-hidden offscreen child", () => {
    const clippedRoot = {
      overflowX: "clip",
      parentElement: null,
      getBoundingClientRect: () => ({ left: 0, right: 390 }),
    };
    const hiddenLayer = {
      tagName: "DIV",
      getAttribute: (name: string) => (name === "aria-hidden" ? "true" : null),
      parentElement: clippedRoot,
      getBoundingClientRect: () => ({ left: 390, right: 780 }),
    };
    const innerOffscreenBox = {
      tagName: "DIV",
      overflowX: "hidden",
      parentElement: hiddenLayer,
      getBoundingClientRect: () => ({ left: 390, right: 780 }),
    };
    expect(isHiddenOffscreenLayer({ parentElement: innerOffscreenBox }, 390, style)).toBe(true);
  });

  test("does not exempt a visible element or SVG icon even under overflow-x hidden", () => {
    const scroller = {
      tagName: "MAIN",
      overflowX: "hidden",
      parentElement: null,
      getBoundingClientRect: () => ({ left: 0, right: 390 }),
    };
    const svgIcon = {
      tagName: "svg",
      overflowX: "hidden",
      getAttribute: (name: string) => (name === "aria-hidden" ? "true" : null),
      parentElement: scroller,
      getBoundingClientRect: () => ({ left: 404, right: 424 }),
    };
    expect(isHiddenOffscreenLayer({ parentElement: scroller }, 390, style)).toBe(false);
    expect(isHiddenOffscreenLayer({ parentElement: svgIcon }, 390, style)).toBe(false);
  });

  test("does not exempt an inert element when clipping ancestor exceeds viewport or lacks overflow-x hidden", () => {
    const wideClip = {
      overflowX: "hidden",
      parentElement: null,
      getBoundingClientRect: () => ({ left: 0, right: 440 }),
    };
    const inertWide = { inert: true, parentElement: wideClip };
    expect(isHiddenOffscreenLayer({ parentElement: inertWide }, 390, style)).toBe(false);

    const visibleParent = {
      overflowX: "visible",
      parentElement: null,
      getBoundingClientRect: () => ({ left: 0, right: 390 }),
    };
    const inertUnclipped = { inert: true, parentElement: visibleParent };
    expect(isHiddenOffscreenLayer({ parentElement: inertUnclipped }, 390, style)).toBe(false);
  });
});

describe("hasCompleteDialogOverlay", () => {
  const mkStyle = (map: Map<unknown, Record<string, string>>) => (el: unknown) =>
    map.get(el) ?? { display: "block", visibility: "visible", opacity: "1", position: "static" };

  test("accepts full-viewport fixed overlay", () => {
    const dialog = { contains: () => false };
    const fixedScrim = {
      getBoundingClientRect: () => ({ left: 0, top: 0, right: 1024, bottom: 768 }),
    };
    const map = new Map([
      [fixedScrim, { display: "block", visibility: "visible", opacity: "1", position: "fixed" }],
    ]);
    expect(hasCompleteDialogOverlay(dialog, [fixedScrim, dialog], 1024, 768, mkStyle(map))).toBe(
      true,
    );
  });

  test("accepts full-viewport data-page-scrim absolute backdrop", () => {
    const dialog = { contains: () => false };
    const pageScrim = {
      hasAttribute: (name: string) => name === "data-page-scrim",
      getBoundingClientRect: () => ({ left: 0, top: 0, right: 1024, bottom: 768 }),
    };
    const map = new Map([
      [pageScrim, { display: "block", visibility: "visible", opacity: "1", position: "absolute" }],
    ]);
    expect(hasCompleteDialogOverlay(dialog, [pageScrim, dialog], 1024, 768, mkStyle(map))).toBe(
      true,
    );
  });

  test("accepts full-viewport data-phone-page-flow ancestor", () => {
    const pageFlow = {
      hasAttribute: (name: string) => name === "data-phone-page-flow",
      parentElement: null,
      getBoundingClientRect: () => ({ left: 0, top: 0, right: 390, bottom: 844 }),
    };
    const dialog = {
      parentElement: pageFlow,
      contains: () => false,
    };
    const map = new Map([
      [pageFlow, { display: "flex", visibility: "visible", opacity: "1", position: "relative" }],
    ]);
    expect(hasCompleteDialogOverlay(dialog, [pageFlow, dialog], 390, 844, mkStyle(map))).toBe(true);
  });

  test("rejects partial, transparent, hidden, or non-scrim absolute elements", () => {
    const dialog = { contains: () => false };
    const partial = { getBoundingClientRect: () => ({ left: 0, top: 0, right: 900, bottom: 768 }) };
    const transparent = {
      hasAttribute: (name: string) => name === "data-page-scrim",
      getBoundingClientRect: () => ({ left: 0, top: 0, right: 1024, bottom: 768 }),
    };
    const hidden = { getBoundingClientRect: () => ({ left: 0, top: 0, right: 1024, bottom: 768 }) };
    const nonScrimAbs = {
      hasAttribute: () => false,
      getBoundingClientRect: () => ({ left: 0, top: 0, right: 1024, bottom: 768 }),
    };
    const map = new Map([
      [partial, { display: "block", visibility: "visible", opacity: "1", position: "fixed" }],
      [
        transparent,
        { display: "block", visibility: "visible", opacity: "0", position: "absolute" },
      ],
      [hidden, { display: "block", visibility: "hidden", opacity: "1", position: "fixed" }],
      [
        nonScrimAbs,
        { display: "block", visibility: "visible", opacity: "1", position: "absolute" },
      ],
    ]);
    expect(
      hasCompleteDialogOverlay(
        dialog,
        [partial, transparent, hidden, nonScrimAbs, dialog],
        1024,
        768,
        mkStyle(map),
      ),
    ).toBe(false);
  });
});

describe("surface viewport filtering", () => {
  test("runSurfaceLoop skips minWidth surfaces on narrower viewports and runs them at or above minWidth", async () => {
    const visitedMobile: string[] = [];
    const visitedDesktop: string[] = [];
    const surfaces = [
      { key: "shared", url: "http://127.0.0.1/shared" },
      { key: "desktop-only", minWidth: 1024, url: "http://127.0.0.1/desktop" },
    ];
    const mkPage = (bag: string[]) => ({
      async navigate(url: string) {
        bag.push(url);
      },
      async screenshot() {},
      consoleSnapshot: () => ({ errors: [], warnings: [] }),
      exceptionsSnapshot: () => [],
    });

    const mobilePass = await runSurfaceLoop({
      page: mkPage(visitedMobile),
      surfaces,
      theme: "light",
      viewport: { name: "390", width: 390, height: 844 },
      outDir: "/tmp",
      evalChecks: async () => ({ findings: [], hasH1: true, sidebarWidth: null }),
      onCaptured: () => {},
    });
    expect(visitedMobile).toEqual(["http://127.0.0.1/shared"]);
    expect(mobilePass.visited).toBe(1);

    const desktopPass = await runSurfaceLoop({
      page: mkPage(visitedDesktop),
      surfaces,
      theme: "light",
      viewport: { name: "1024", width: 1024, height: 768 },
      outDir: "/tmp",
      evalChecks: async () => ({ findings: [], hasH1: true, sidebarWidth: 160 }),
      onCaptured: () => {},
    });
    expect(visitedDesktop).toEqual(["http://127.0.0.1/shared", "http://127.0.0.1/desktop"]);
    expect(desktopPass.visited).toBe(2);
  });

  test("buildSurfaces marks desktop-only sidebar surfaces with minWidth 1024", () => {
    const { surfaces } = buildSurfaces(
      { workspaceSlug: "dev", agentId: "a1", computerId: "c1", channelId: "ch1", dmId: "dm1" },
      { baseUrl: "http://127.0.0.1:8795", locale: "en" },
    );
    const byKey = new Map(surfaces.map((s) => [s.key, s]));
    for (const key of [
      "menu-workspace-switcher",
      "menu-user-menu",
      "sidebar-collapsed-tooltip",
      "sidebar-mid-resize",
    ]) {
      expect(byKey.get(key)?.minWidth).toBe(1024);
    }
    expect(byKey.get("dialog-create-channel")?.minWidth).toBeUndefined();
    expect(byKey.get("settings-account-edit-form")?.minWidth).toBeUndefined();
  });
});
