import { expect, test } from "bun:test";
import { join } from "node:path";

import { shouldSendAsTaskOnEnter } from "#src/features/conversations/composer-behavior";
import { SHORTCUT_GROUPS } from "#src/features/shortcuts/keyboard-shortcuts";
import { HOTKEYS, hotkeyAria, hotkeyKeycaps, hotkeyLabel } from "#src/lib/hotkeys";
import { m } from "#src/paraglide/messages";

const src = join(import.meta.dir, "../src");
const rowKeys = (label: () => string) =>
  SHORTCUT_GROUPS.flatMap((group) => group.rows).find((row) => row.label === label)?.keys;

test("the panel has its four groups, each row named once with at least one key", () => {
  expect(SHORTCUT_GROUPS.map((group) => group.title())).toEqual([
    m.shortcuts_group_global(),
    m.shortcuts_group_composer(),
    m.shortcuts_group_messages(),
    m.shortcuts_group_previews(),
  ]);
  const labels = SHORTCUT_GROUPS.flatMap((group) => group.rows.map((row) => row.label()));
  expect(new Set(labels).size).toBe(labels.length);
  for (const group of SHORTCUT_GROUPS)
    for (const row of group.rows) expect(row.keys.length).toBeGreaterThan(0);
});

test("keys read as the viewer's keyboard names them: ⌘ on a Mac, Ctrl elsewhere", () => {
  expect(hotkeyKeycaps(HOTKEYS.sendAsTask, true)).toEqual(["⌘", "⇧", "↵"]);
  expect(hotkeyKeycaps(HOTKEYS.sendAsTask, false)).toEqual(["Ctrl", "Shift", "↵"]);
  expect(hotkeyKeycaps(HOTKEYS.shortcuts, true)).toEqual(["⌘", "/"]);
  expect(hotkeyKeycaps("Alt+ArrowUp", true)).toEqual(["⌥", "↑"]);
  expect(hotkeyLabel(HOTKEYS.search, true)).toBe("⌘K");
  expect(hotkeyLabel(HOTKEYS.search, false)).toBe("Ctrl+K");
  expect(hotkeyLabel(HOTKEYS.sidebar, true)).toBe("⌘B");
  expect(hotkeyLabel(HOTKEYS.sidebar, false)).toBe("Ctrl+B");
  expect(hotkeyLabel(HOTKEYS.sendAsTask, true)).toBe("⌘⇧Enter");
  expect(hotkeyLabel(HOTKEYS.sendAsTask, false)).toBe("Ctrl+Shift+Enter");
  expect(hotkeyAria(HOTKEYS.search, true)).toBe("Meta+K");
  expect(hotkeyAria(HOTKEYS.search, false)).toBe("Control+K");
});

test("the panel's search and sidebar keys are the ones the app binds", async () => {
  expect(rowKeys(m.shortcuts_search)).toEqual([HOTKEYS.search]);
  expect(rowKeys(m.shortcuts_sidebar)).toEqual([HOTKEYS.sidebar]);
  expect(rowKeys(m.shortcuts_open)).toEqual([HOTKEYS.shortcuts]);
  const search = await Bun.file(join(src, "features/search/search-shortcut.ts")).text();
  const sidebar = await Bun.file(join(src, "features/settings/sidebar-shortcut.tsx")).text();
  const host = await Bun.file(join(src, "features/shortcuts/keyboard-shortcuts-host.tsx")).text();
  expect(search).toContain("useHotkey(HOTKEYS.search,");
  expect(sidebar).toMatch(/useHotkey\(\s*HOTKEYS\.sidebar,/);
  expect(host).toContain("useHotkey(HOTKEYS.shortcuts,");
  for (const source of [search, sidebar, host]) expect(source).not.toMatch(/"Mod\+/);
});

test("the panel's send-as-task key is the one the composer acts on", () => {
  expect(rowKeys(m.shortcuts_send_as_task)).toEqual([HOTKEYS.sendAsTask]);
  const parts = HOTKEYS.sendAsTask.split("+");
  const press = (mac: boolean) =>
    shouldSendAsTaskOnEnter(
      {
        key: parts.at(-1)!,
        shiftKey: parts.includes("Shift"),
        metaKey: mac && parts.includes("Mod"),
        ctrlKey: !mac && parts.includes("Mod"),
        isComposing: false,
      },
      { lastCompositionEndAt: null, now: 0 },
    );
  expect(press(true)).toBe(true);
  expect(press(false)).toBe(true);
});
