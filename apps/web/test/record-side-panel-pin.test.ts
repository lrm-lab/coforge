import { expect, test } from "bun:test";

import {
  defaultSidePanelPinned,
  sidePanelOpensOnEntry,
  sidePanelPinStorageKey,
} from "#src/features/records/record-side-panel-pin";

test("defaultSidePanelPinned matches historical auto-open surfaces", () => {
  expect(defaultSidePanelPinned("format")).toBe(true);
  expect(defaultSidePanelPinned("member-leader")).toBe(true);
  expect(defaultSidePanelPinned("member-assignee")).toBe(true);
  expect(defaultSidePanelPinned("plain")).toBe(false);
});

test("below lg only a pin the reader made opens the panel on entry", () => {
  const stored = new Map<string, string>();
  const previous = globalThis.window;
  Object.assign(globalThis, {
    window: { localStorage: { getItem: (key: string) => stored.get(key) ?? null } },
  });
  try {
    expect(sidePanelOpensOnEntry("report", "r1", "member-assignee", true)).toBe(true);
    expect(sidePanelOpensOnEntry("report", "r1", "member-assignee", false)).toBe(false);
    stored.set(sidePanelPinStorageKey("report", "r1"), "1");
    expect(sidePanelOpensOnEntry("report", "r1", "plain", false)).toBe(true);
    stored.set(sidePanelPinStorageKey("report", "r1"), "0");
    expect(sidePanelOpensOnEntry("report", "r1", "format", true)).toBe(false);
  } finally {
    Object.assign(globalThis, { window: previous });
  }
});
