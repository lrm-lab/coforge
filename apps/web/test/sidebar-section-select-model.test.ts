import { describe, expect, test } from "bun:test";

import {
  DEFAULT_SECTION_OPTION,
  PINNED_SECTION_OPTION,
  buildSidebarSectionOptions,
  parseSidebarSectionKey,
  resolveSidebarSectionKey,
} from "#src/features/conversations/sidebar-section-select-model";

describe("sidebar-section-select-model", () => {
  const sections = [
    { id: "sec-1", name: "Core", emoji: "🔥", conversationIds: ["c-2", "c-3"] },
    { id: "sec-2", name: "Ops", emoji: null, conversationIds: ["c-4"] },
  ];

  test("resolveSidebarSectionKey prefers pinned over custom section membership", () => {
    expect(resolveSidebarSectionKey({ conversationId: "c-2", pinned: true, sections })).toBe(
      PINNED_SECTION_OPTION,
    );
  });

  test("resolveSidebarSectionKey returns matching custom section when unpinned", () => {
    expect(resolveSidebarSectionKey({ conversationId: "c-2", pinned: false, sections })).toBe(
      "section:sec-1",
    );
    expect(resolveSidebarSectionKey({ conversationId: "c-4", pinned: false, sections })).toBe(
      "section:sec-2",
    );
  });

  test("resolveSidebarSectionKey falls back to default when neither pinned nor in a section", () => {
    expect(resolveSidebarSectionKey({ conversationId: "c-999", pinned: false, sections })).toBe(
      DEFAULT_SECTION_OPTION,
    );
  });

  test("parseSidebarSectionKey distinguishes pinned, default, and custom section keys", () => {
    expect(parseSidebarSectionKey(PINNED_SECTION_OPTION)).toEqual({ kind: "pinned" });
    expect(parseSidebarSectionKey(DEFAULT_SECTION_OPTION)).toEqual({ kind: "default" });
    expect(parseSidebarSectionKey("section:sec-1")).toEqual({
      kind: "section",
      sectionId: "sec-1",
    });
  });

  test("buildSidebarSectionOptions orders pinned, custom sections with optional emoji, and default", () => {
    expect(
      buildSidebarSectionOptions({
        sections,
        pinnedLabel: "Pinned",
        defaultLabel: "Channels",
      }),
    ).toEqual([
      { id: "pinned", label: "Pinned" },
      { id: "section:sec-1", label: "🔥 Core" },
      { id: "section:sec-2", label: "Ops" },
      { id: "default", label: "Channels" },
    ]);
  });
});
