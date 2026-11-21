import { describe, expect, test } from "bun:test";

import {
  SUBPAGE_VIEW_TRANSITION_TYPES,
  resolveSubpageViewTransitionTypes,
  subpageDepth,
  subpageTransitionDirection,
} from "./subpage-transition";

describe("subpageDepth", () => {
  test("assigns depth 0 to the four mobile tab homes", () => {
    expect(subpageDepth("")).toBe(0);
    expect(subpageDepth("/")).toBe(0);
    expect(subpageDepth("/activity")).toBe(0);
    expect(subpageDepth("/workspace")).toBe(0);
    expect(subpageDepth("/me")).toBe(0);
  });

  test("assigns depth 1 to top-level subpages and Records peer tabs", () => {
    expect(subpageDepth("/projects")).toBe(1);
    expect(subpageDepth("/artifacts")).toBe(1);
    expect(subpageDepth("/members")).toBe(1);
    expect(subpageDepth("/memory")).toBe(1);
    expect(subpageDepth("/computers")).toBe(1);
    expect(subpageDepth("/settings")).toBe(1);
    expect(subpageDepth("/tasks")).toBe(1);
    expect(subpageDepth("/pi-chat")).toBe(1);
    expect(subpageDepth("/search")).toBe(1);
    expect(subpageDepth("/app-review")).toBe(1);
    expect(subpageDepth("/records")).toBe(1);
    expect(subpageDepth("/records/dashboard")).toBe(1);
    expect(subpageDepth("/records/stats")).toBe(1);
    expect(subpageDepth("/records/settings")).toBe(1);
  });

  test("assigns depth 2 to detail subpages", () => {
    expect(subpageDepth("/projects/coforge")).toBe(2);
    expect(subpageDepth("/artifacts/art-1")).toBe(2);
    expect(subpageDepth("/computer/comp-1")).toBe(2);
    expect(subpageDepth("/agent/agent-1")).toBe(2);
    expect(subpageDepth("/memory/personal")).toBe(2);
    expect(subpageDepth("/records/rec-1")).toBe(2);
    expect(subpageDepth("/records/weeks/2026/47")).toBe(2);
  });

  test("assigns depth 3 to nested project subpages", () => {
    expect(subpageDepth("/projects/coforge/settings")).toBe(3);
    expect(subpageDepth("/projects/coforge/tree/src/app.tsx")).toBe(3);
  });
});

describe("subpageTransitionDirection", () => {
  test("pushes when entering subpages from tab homes and pops on back", () => {
    expect(subpageTransitionDirection("/w/acme/workspace", "/w/acme/projects")).toBe("push");
    expect(subpageTransitionDirection("/w/acme/projects", "/w/acme/workspace")).toBe("pop");
    expect(subpageTransitionDirection("/w/acme/me", "/w/acme/settings")).toBe("push");
    expect(subpageTransitionDirection("/w/acme/settings", "/w/acme/me")).toBe("pop");
  });

  test("pushes and pops across multi-level list and detail subpages", () => {
    expect(subpageTransitionDirection("/w/acme/projects", "/w/acme/projects/web")).toBe("push");
    expect(subpageTransitionDirection("/w/acme/projects/web", "/w/acme/projects")).toBe("pop");
    expect(
      subpageTransitionDirection("/w/acme/projects/web", "/w/acme/projects/web/settings"),
    ).toBe("push");
    expect(
      subpageTransitionDirection("/w/acme/projects/web/settings", "/w/acme/projects/web"),
    ).toBe("pop");
    expect(subpageTransitionDirection("/w/acme/artifacts", "/w/acme/artifacts/art-1")).toBe("push");
    expect(subpageTransitionDirection("/w/acme/artifacts/art-1", "/w/acme/artifacts")).toBe("pop");
    expect(subpageTransitionDirection("/w/acme/computers", "/w/acme/computer/c-1")).toBe("push");
    expect(subpageTransitionDirection("/w/acme/computer/c-1", "/w/acme/computers")).toBe("pop");
    expect(subpageTransitionDirection("/w/acme/records", "/w/acme/records/rec-1")).toBe("push");
    expect(subpageTransitionDirection("/w/acme/records/rec-1", "/w/acme/records")).toBe("pop");
    expect(subpageTransitionDirection("/w/acme/memory", "/w/acme/memory/personal")).toBe("push");
    expect(subpageTransitionDirection("/w/acme/memory/personal", "/w/acme/memory")).toBe("pop");
    expect(subpageTransitionDirection("/w/acme/members", "/w/acme/agent/a-1")).toBe("push");
    expect(subpageTransitionDirection("/w/acme/agent/a-1", "/w/acme/members")).toBe("pop");
  });

  test("supports localized workspace URLs", () => {
    expect(subpageTransitionDirection("/zh-CN/w/acme/workspace", "/zh-CN/w/acme/projects")).toBe(
      "push",
    );
    expect(subpageTransitionDirection("/zh-CN/w/acme/settings", "/zh-CN/w/acme/me")).toBe("pop");
  });

  test("skips tab switches, peer subpages, chat-internal navigation, and cross-workspace routes", () => {
    expect(subpageTransitionDirection("/w/acme/workspace", "/w/acme/me")).toBeNull();
    expect(subpageTransitionDirection("/w/acme", "/w/acme/activity")).toBeNull();
    expect(subpageTransitionDirection("/w/acme/records", "/w/acme/records/dashboard")).toBeNull();
    expect(subpageTransitionDirection("/w/acme/projects/a", "/w/acme/projects/b")).toBeNull();
    expect(subpageTransitionDirection("/w/acme", "/w/acme/channel/c-1")).toBeNull();
    expect(subpageTransitionDirection("/w/acme/channel/c-1", "/w/acme")).toBeNull();
    expect(subpageTransitionDirection("/w/acme/channel/c-1", "/w/acme/dm/d-1")).toBeNull();
    expect(subpageTransitionDirection("/w/acme/workspace", "/w/other/projects")).toBeNull();
    expect(subpageTransitionDirection("/login", "/w/acme")).toBeNull();
  });
});

describe("resolveSubpageViewTransitionTypes", () => {
  test("returns push and pop view-transition types on mobile when supported", () => {
    const mobileEnv = { isDesktop: false, supportsViewTransitionTypes: true };
    expect(
      resolveSubpageViewTransitionTypes(
        {
          fromLocation: { pathname: "/w/acme/workspace" },
          toLocation: { pathname: "/w/acme/projects" },
          pathChanged: true,
        },
        mobileEnv,
      ),
    ).toEqual([SUBPAGE_VIEW_TRANSITION_TYPES.push]);
    expect(
      resolveSubpageViewTransitionTypes(
        {
          fromLocation: { pathname: "/w/acme/projects" },
          toLocation: { pathname: "/w/acme/workspace" },
          pathChanged: true,
        },
        mobileEnv,
      ),
    ).toEqual([SUBPAGE_VIEW_TRANSITION_TYPES.pop]);
  });

  test("skips view transitions on desktop, same-path changes, initial load, or unsupported browsers", () => {
    const pushChange = {
      fromLocation: { pathname: "/w/acme/workspace" },
      toLocation: { pathname: "/w/acme/projects" },
      pathChanged: true,
    };
    expect(
      resolveSubpageViewTransitionTypes(pushChange, {
        isDesktop: true,
        supportsViewTransitionTypes: true,
      }),
    ).toBe(false);
    expect(
      resolveSubpageViewTransitionTypes(pushChange, {
        isDesktop: false,
        supportsViewTransitionTypes: false,
      }),
    ).toBe(false);
    expect(
      resolveSubpageViewTransitionTypes(pushChange, {
        isDesktop: false,
        supportsViewTransitionTypes: true,
        hasUAVisualTransition: true,
      }),
    ).toBe(false);
    expect(
      resolveSubpageViewTransitionTypes(
        { ...pushChange, pathChanged: false },
        { isDesktop: false, supportsViewTransitionTypes: true },
      ),
    ).toBe(false);
    expect(
      resolveSubpageViewTransitionTypes(
        { toLocation: { pathname: "/w/acme/projects" }, pathChanged: true },
        { isDesktop: false, supportsViewTransitionTypes: true },
      ),
    ).toBe(false);
  });
});
