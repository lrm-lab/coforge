import { beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { shouldSendAsTaskOnEnter } from "#src/features/conversations/composer-behavior";
import { ShortcutKeycaps } from "#src/features/shortcuts/shortcut-keycaps";
import {
  CONFIGURABLE_SHORTCUT_GROUPS,
  FIXED_SHORTCUT_ROWS,
  filterShortcuts,
  resolveShortcutGroups,
  SHORTCUT_GROUPS,
  SHORTCUT_MODAL_COLUMNS,
} from "#src/features/shortcuts/keyboard-shortcuts";
import {
  addShortcutBinding,
  clearShortcutBindings,
  hasCustomShortcuts,
  isShortcutCustomized,
  parseStoredShortcutOverrides,
  readAllShortcutBindings,
  readShortcutBindings,
  removeShortcutBinding,
  replaceShortcutBinding,
  resetAllShortcutBindings,
  resetShortcutBinding,
  SHORTCUTS_STORAGE_KEY,
  validateShortcutCandidate,
} from "#src/features/shortcuts/shortcut-bindings";
import {
  DEFAULT_HOTKEY_BINDINGS,
  hasPrimaryModifier,
  HOTKEYS,
  hotkeyAria,
  hotkeyKeycaps,
  hotkeyLabel,
  hotkeyMatchesEvent,
  recordHotkeyFromEvent,
} from "#src/lib/hotkeys";
import { m } from "#src/paraglide/messages";

const src = join(import.meta.dir, "../src");
const rowKeys = (label: () => string) =>
  SHORTCUT_GROUPS.flatMap((group) => group.rows).find((row) => row.label === label)?.keys;

function installMemoryStorage() {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
      removeItem: (key: string) => {
        store.delete(key);
      },
      clear: () => {
        store.clear();
      },
    },
  });
  return store;
}

beforeEach(() => {
  installMemoryStorage();
  resetAllShortcutBindings();
});

test("the panel groups shortcuts by scope into three desktop columns, each row named once", () => {
  expect(SHORTCUT_GROUPS.map((group) => group.title())).toEqual([
    m.shortcuts_group_global(),
    m.shortcuts_group_composer(),
    m.shortcuts_group_question_cards(),
    m.shortcuts_group_messages(),
    m.shortcuts_group_activity(),
    m.shortcuts_group_previews(),
  ]);
  expect(SHORTCUT_MODAL_COLUMNS).toEqual([
    ["global", "composer"],
    ["questionCards", "messages", "activity"],
    ["previews"],
  ]);
  const byId = new Map(SHORTCUT_GROUPS.map((group) => [group.id, group]));
  expect(byId.get("global")?.rows.map((row) => row.label)).toContain(m.shortcuts_dialog_submit);
  expect(byId.get("questionCards")?.rows.map((row) => row.label)).toEqual([
    m.shortcuts_question_jump,
    m.shortcuts_card_move,
    m.shortcuts_card_pick,
    m.shortcuts_card_tick,
    m.shortcuts_card_switch,
    m.shortcuts_card_back,
  ]);
  expect(byId.get("messages")?.rows.map((row) => row.label)).toEqual([m.shortcuts_leave]);
  expect(byId.get("activity")?.rows.map((row) => row.id)).toEqual([
    "activityNext",
    "activityPrev",
    "activityDone",
    "activityRead",
  ]);
  const labels = SHORTCUT_GROUPS.flatMap((group) => group.rows.map((row) => row.label()));
  expect(new Set(labels).size).toBe(labels.length);
  for (const group of SHORTCUT_GROUPS)
    for (const row of group.rows) expect(row.keys.length).toBeGreaterThan(0);
  const configurableCount = CONFIGURABLE_SHORTCUT_GROUPS.reduce(
    (sum, group) => sum + group.items.length,
    0,
  );
  expect(configurableCount + FIXED_SHORTCUT_ROWS.length).toBe(labels.length);
});

test("keys read as the viewer's keyboard names them: ? opens the panel, ⌘ on Mac, Ctrl elsewhere", () => {
  expect(HOTKEYS.shortcuts).toBe("?");
  expect(hotkeyKeycaps(HOTKEYS.shortcuts, true)).toEqual(["?"]);
  expect(hotkeyKeycaps(HOTKEYS.shortcuts, false)).toEqual(["?"]);
  expect(hotkeyLabel(HOTKEYS.shortcuts, true)).toBe("?");
  expect(hotkeyKeycaps(HOTKEYS.sendAsTask, true)).toEqual(["⌘", "⇧", "↵"]);
  expect(hotkeyKeycaps(HOTKEYS.sendAsTask, false)).toEqual(["Ctrl", "Shift", "↵"]);
  expect(hotkeyKeycaps("Alt+ArrowUp", true)).toEqual(["⌥", "↑"]);
  expect(hotkeyKeycaps("Control+O", true)).toEqual(["⌃", "O"]);
  expect(hotkeyKeycaps("Control+O", false)).toEqual(["Ctrl", "O"]);
  expect(hotkeyLabel(HOTKEYS.search, true)).toBe("⌘K");
  expect(hotkeyLabel(HOTKEYS.search, false)).toBe("Ctrl+K");
  expect(hotkeyLabel(HOTKEYS.sidebar, true)).toBe("⌘B");
  expect(hotkeyLabel(HOTKEYS.sidebar, false)).toBe("Ctrl+B");
  expect(hotkeyLabel(HOTKEYS.sendAsTask, true)).toBe("⌘⇧Enter");
  expect(hotkeyLabel(HOTKEYS.sendAsTask, false)).toBe("Ctrl+Shift+Enter");
  expect(hotkeyAria(HOTKEYS.search, true)).toBe("Meta+K");
  expect(hotkeyAria(HOTKEYS.search, false)).toBe("Control+K");
  expect(hasPrimaryModifier("?")).toBe(false);
  expect(hasPrimaryModifier("J")).toBe(false);
  expect(hasPrimaryModifier("Mod+K")).toBe(true);
  expect(hasPrimaryModifier("Control+O")).toBe(true);
  expect(hasPrimaryModifier("Alt+K")).toBe(true);
});

test("hotkeyMatchesEvent matches ? and modifier combos across platforms", () => {
  expect(
    hotkeyMatchesEvent(
      "?",
      { key: "?", code: "Slash", shiftKey: true, ctrlKey: false, altKey: false, metaKey: false },
      true,
    ),
  ).toBe(true);
  expect(
    hotkeyMatchesEvent(
      "?",
      { key: "/", code: "Slash", shiftKey: false, ctrlKey: false, altKey: false, metaKey: false },
      true,
    ),
  ).toBe(false);
  expect(
    hotkeyMatchesEvent(
      "Mod+K",
      { key: "k", code: "KeyK", shiftKey: false, ctrlKey: false, altKey: false, metaKey: true },
      true,
    ),
  ).toBe(true);
  expect(
    hotkeyMatchesEvent(
      "Mod+K",
      { key: "k", code: "KeyK", shiftKey: false, ctrlKey: true, altKey: false, metaKey: false },
      false,
    ),
  ).toBe(true);
  expect(
    hotkeyMatchesEvent(
      "Mod+K",
      {
        key: "k",
        code: "KeyK",
        shiftKey: false,
        ctrlKey: false,
        altKey: false,
        metaKey: true,
        isComposing: true,
      },
      true,
    ),
  ).toBe(false);
});

test("recordHotkeyFromEvent captures ?, modifier combos, and macOS Option letters cleanly", () => {
  expect(
    recordHotkeyFromEvent(
      { key: "?", code: "Slash", shiftKey: true, ctrlKey: false, altKey: false, metaKey: false },
      true,
    ),
  ).toBe("?");
  expect(
    recordHotkeyFromEvent(
      { key: "k", code: "KeyK", shiftKey: false, ctrlKey: false, altKey: false, metaKey: true },
      true,
    ),
  ).toBe("Mod+K");
  expect(
    recordHotkeyFromEvent(
      { key: "o", code: "KeyO", shiftKey: false, ctrlKey: true, altKey: false, metaKey: false },
      true,
    ),
  ).toBe("Control+O");
  expect(
    recordHotkeyFromEvent(
      { key: "˚", code: "KeyK", shiftKey: false, ctrlKey: false, altKey: true, metaKey: false },
      true,
    ),
  ).toBe("Alt+K");
  expect(
    recordHotkeyFromEvent(
      {
        key: "Shift",
        code: "ShiftLeft",
        shiftKey: true,
        ctrlKey: false,
        altKey: false,
        metaKey: false,
      },
      true,
    ),
  ).toBeNull();
  expect(
    recordHotkeyFromEvent(
      {
        key: "k",
        code: "KeyK",
        shiftKey: false,
        ctrlKey: false,
        altKey: false,
        metaKey: true,
        isComposing: true,
      },
      true,
    ),
  ).toBeNull();
});

test("shortcut bindings persist per device, support aliases, reset cleanly, and validate conflicts", () => {
  expect(readShortcutBindings("shortcuts")).toEqual(["?"]);
  expect(readShortcutBindings("draftRedo")).toEqual(["Mod+Shift+Z", "Mod+Y"]);

  replaceShortcutBinding("search", 0, "Mod+P");
  expect(readShortcutBindings("search")).toEqual(["Mod+P"]);
  expect(isShortcutCustomized("search")).toBe(true);
  expect(hasCustomShortcuts()).toBe(true);
  expect(JSON.parse(localStorage.getItem(SHORTCUTS_STORAGE_KEY) ?? "{}")).toEqual({
    search: ["Mod+P"],
  });

  addShortcutBinding("search", "Control+O");
  expect(readShortcutBindings("search")).toEqual(["Mod+P", "Control+O"]);

  removeShortcutBinding("search", 0);
  expect(readShortcutBindings("search")).toEqual(["Control+O"]);

  clearShortcutBindings("search");
  expect(readShortcutBindings("search")).toEqual([]);
  expect(isShortcutCustomized("search")).toBe(true);

  resetShortcutBinding("search");
  expect(readShortcutBindings("search")).toEqual(DEFAULT_HOTKEY_BINDINGS.search);
  expect(isShortcutCustomized("search")).toBe(false);
  expect(hasCustomShortcuts()).toBe(false);

  const bindings = readAllShortcutBindings();
  expect(validateShortcutCandidate("search", "Mod+B", bindings, true)).toEqual({
    ok: false,
    reason: "conflict",
    conflictId: "sidebar",
  });
  expect(validateShortcutCandidate("activityDone", "Mod+F", bindings, true)).toEqual({ ok: true });
  expect(validateShortcutCandidate("search", "Mod+F", bindings, true)).toEqual({
    ok: false,
    reason: "conflict",
    conflictId: "previewFind",
  });
  expect(validateShortcutCandidate("sendAsTask", "K", bindings, true)).toEqual({
    ok: false,
    reason: "requires-modifier",
  });
  expect(validateShortcutCandidate("search", "Escape", bindings, true)).toEqual({
    ok: false,
    reason: "reserved",
  });
  expect(parseStoredShortcutOverrides("not json")).toEqual({});
  expect(
    parseStoredShortcutOverrides(
      JSON.stringify({ unknown: ["Mod+X"], search: ["Mod+P", "Mod+P"] }),
    ),
  ).toEqual({
    search: ["Mod+P"],
  });
});

test("resolveShortcutGroups and filterShortcuts reflect live overrides and queries", () => {
  replaceShortcutBinding("search", 0, "Control+O");
  addShortcutBinding("search", "Mod+K");
  const groups = resolveShortcutGroups(readAllShortcutBindings());
  const searchRow = groups.flatMap((g) => g.rows).find((r) => r.id === "search");
  expect(searchRow?.keys).toEqual(["Control+O", "Mod+K"]);

  const activityNextRow = groups.flatMap((g) => g.rows).find((r) => r.id === "activityNext");
  expect(activityNextRow?.keys).toEqual(["J", "ArrowDown"]);

  const hits = filterShortcuts(
    "ctrl+o",
    CONFIGURABLE_SHORTCUT_GROUPS,
    readAllShortcutBindings(),
    false,
  );
  expect(hits.flatMap((g) => g.items)).toEqual(["search"]);
});

test("the panel's configurable keys are the ones the app binds", async () => {
  expect(rowKeys(m.shortcuts_search)).toEqual([HOTKEYS.search]);
  expect(rowKeys(m.shortcuts_sidebar)).toEqual([HOTKEYS.sidebar]);
  expect(rowKeys(m.shortcuts_open)).toEqual([HOTKEYS.shortcuts]);
  const search = await Bun.file(join(src, "features/search/search-shortcut.ts")).text();
  const sidebar = await Bun.file(join(src, "features/settings/sidebar-shortcut.tsx")).text();
  const host = await Bun.file(join(src, "features/shortcuts/keyboard-shortcuts-host.tsx")).text();
  expect(search).toContain('useShortcutBindings("search")');
  expect(sidebar).toContain('useShortcutBindings("sidebar")');
  expect(host).toContain('useShortcutBindings("shortcuts")');
  for (const source of [search, sidebar, host]) expect(source).not.toMatch(/"Mod\+/);
});

test("the panel's send-as-task key is the one the composer acts on, including custom bindings", () => {
  expect(rowKeys(m.shortcuts_send_as_task)).toEqual([HOTKEYS.sendAsTask]);
  const pressDefault = (mac: boolean) =>
    shouldSendAsTaskOnEnter(
      {
        key: "Enter",
        code: "Enter",
        shiftKey: true,
        metaKey: mac,
        ctrlKey: !mac,
        altKey: false,
        isComposing: false,
      },
      { lastCompositionEndAt: null, now: 0 },
      undefined,
      mac,
    );
  expect(pressDefault(true)).toBe(true);
  expect(pressDefault(false)).toBe(true);

  expect(
    shouldSendAsTaskOnEnter(
      {
        key: "Enter",
        code: "Enter",
        shiftKey: false,
        metaKey: false,
        ctrlKey: false,
        altKey: true,
        isComposing: false,
      },
      { lastCompositionEndAt: null, now: 0 },
      ["Alt+Enter"],
      true,
    ),
  ).toBe(true);
  expect(
    shouldSendAsTaskOnEnter(
      {
        key: "Enter",
        code: "Enter",
        shiftKey: true,
        metaKey: true,
        ctrlKey: false,
        altKey: false,
        isComposing: false,
      },
      { lastCompositionEndAt: null, now: 0 },
      ["Alt+Enter"],
      true,
    ),
  ).toBe(false);
});

test("ShortcutKeycaps separates alternative bindings with a visual slash and screen-reader 'or'", () => {
  const html = renderToStaticMarkup(
    createElement(ShortcutKeycaps, {
      hotkeys: ["Alt+ArrowUp", "Alt+ArrowDown"],
      apple: true,
    }),
  );
  expect(html).toContain('aria-hidden="true"');
  expect(html).toContain(">/<");
  expect(html).toContain(`class="sr-only"> ${m.shortcuts_or()} <`);
  expect(html).toContain('data-hotkey="Alt+ArrowUp"');
  expect(html).toContain('data-hotkey="Alt+ArrowDown"');
});
