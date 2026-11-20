import {
  DEFAULT_HOTKEY_BINDINGS,
  hotkeyLabel,
  type ConfigurableShortcutId,
} from "#src/lib/hotkeys";
import { m } from "#src/paraglide/messages";
import type { ShortcutBindingMap } from "./shortcut-bindings";

export type ShortcutGroupId = "global" | "composer" | "messages" | "previews";

export type ShortcutRow = {
  id?: ConfigurableShortcutId;
  label: () => string;
  keys: readonly string[];
  extraKeys?: readonly string[];
};

export type ShortcutGroup = {
  id: ShortcutGroupId;
  title: () => string;
  rows: readonly ShortcutRow[];
};

export type ConfigurableShortcutGroup = {
  id: ShortcutGroupId;
  title: () => string;
  items: readonly ConfigurableShortcutId[];
};

type ShortcutCatalogRow =
  | { id: ConfigurableShortcutId; label: () => string; extraKeys?: readonly string[] }
  | { id?: undefined; label: () => string; keys: readonly string[] };

type ShortcutCatalogGroup = {
  id: ShortcutGroupId;
  title: () => string;
  rows: readonly ShortcutCatalogRow[];
};

const SHORTCUT_CATALOG: readonly ShortcutCatalogGroup[] = [
  {
    id: "global",
    title: m.shortcuts_group_global,
    rows: [
      { id: "shortcuts", label: m.shortcuts_open },
      { id: "search", label: m.shortcuts_search },
      { id: "sidebar", label: m.shortcuts_sidebar },
    ],
  },
  {
    id: "composer",
    title: m.shortcuts_group_composer,
    rows: [
      { label: m.shortcuts_send, keys: ["Enter"] },
      { label: m.shortcuts_newline, keys: ["Shift+Enter"] },
      { id: "sendAsTask", label: m.shortcuts_send_as_task },
      { label: m.shortcuts_mention_move, keys: ["ArrowUp", "ArrowDown"] },
      { label: m.shortcuts_mention_insert, keys: ["Enter", "Tab"] },
      { label: m.shortcuts_question_jump, keys: ["Alt+ArrowUp", "Alt+ArrowDown"] },
      { label: m.shortcuts_dialog_submit, keys: ["Mod+Enter"] },
    ],
  },
  {
    id: "messages",
    title: m.shortcuts_group_messages,
    rows: [
      { label: m.shortcuts_card_move, keys: ["ArrowUp", "ArrowDown"] },
      { label: m.shortcuts_card_pick, keys: ["1–9"] },
      { label: m.shortcuts_card_tick, keys: ["Space"] },
      { label: m.shortcuts_card_switch, keys: ["ArrowLeft", "ArrowRight"] },
      { label: m.shortcuts_card_back, keys: ["Escape"] },
      { label: m.shortcuts_leave, keys: ["Escape"] },
      { id: "activityNext", label: m.shortcuts_activity_next, extraKeys: ["ArrowDown"] },
      { id: "activityPrev", label: m.shortcuts_activity_prev, extraKeys: ["ArrowUp"] },
      { id: "activityDone", label: m.shortcuts_activity_done },
      { id: "activityRead", label: m.shortcuts_activity_read },
    ],
  },
  {
    id: "previews",
    title: m.shortcuts_group_previews,
    rows: [
      { id: "previewFind", label: m.shortcuts_find },
      { label: m.shortcuts_match, keys: ["Enter", "Shift+Enter"] },
      { label: m.shortcuts_comment_post, keys: ["Mod+Enter"] },
      { label: m.shortcuts_draft_switch, keys: ["ArrowUp", "ArrowDown"] },
      { id: "draftUndo", label: m.shortcuts_undo },
      { id: "draftRedo", label: m.shortcuts_redo },
      { label: m.shortcuts_page_switch, keys: ["ArrowLeft", "ArrowRight"] },
      { label: m.shortcuts_present_exit, keys: ["Escape"] },
    ],
  },
];

export const SHORTCUT_MODAL_COLUMNS: readonly (readonly ShortcutGroupId[])[] = [
  ["global", "composer"],
  ["messages"],
  ["previews"],
];

export function resolveShortcutGroups(
  bindings: ShortcutBindingMap = DEFAULT_HOTKEY_BINDINGS,
): readonly ShortcutGroup[] {
  return SHORTCUT_CATALOG.map((group) => ({
    id: group.id,
    title: group.title,
    rows: group.rows.map((row): ShortcutRow => {
      if (!row.id) return { label: row.label, keys: row.keys };
      const custom = bindings[row.id];
      const extra = row.extraKeys ?? [];
      const combined = [...custom];
      for (const key of extra) if (!combined.includes(key)) combined.push(key);
      return {
        id: row.id,
        label: row.label,
        keys: combined,
        extraKeys: row.extraKeys,
      };
    }),
  }));
}

export const SHORTCUT_GROUPS: readonly ShortcutGroup[] =
  resolveShortcutGroups(DEFAULT_HOTKEY_BINDINGS);

export const CONFIGURABLE_SHORTCUT_GROUPS: readonly ConfigurableShortcutGroup[] =
  SHORTCUT_CATALOG.map((group) => ({
    id: group.id,
    title: group.title,
    items: group.rows.flatMap((row) => (row.id ? [row.id] : [])),
  })).filter((group) => group.items.length > 0);

export const CONFIGURABLE_SHORTCUT_META = Object.fromEntries(
  SHORTCUT_CATALOG.flatMap((group) =>
    group.rows.flatMap((row) =>
      row.id ? [[row.id, { label: row.label, extraKeys: row.extraKeys }]] : [],
    ),
  ),
) as Record<ConfigurableShortcutId, { label: () => string; extraKeys?: readonly string[] }>;

export const FIXED_SHORTCUT_ROWS: readonly ShortcutRow[] = SHORTCUT_CATALOG.flatMap((group) =>
  group.rows.flatMap((row) => (row.id ? [] : [{ label: row.label, keys: row.keys }])),
);

function matchesQuery(needle: string, label: string, keys: readonly string[], apple: boolean) {
  if (label.toLowerCase().includes(needle)) return true;
  return keys.some((key) => {
    const formatted = hotkeyLabel(key, apple).toLowerCase();
    return formatted.includes(needle) || key.toLowerCase().includes(needle);
  });
}

export function filterShortcuts(
  query: string,
  groups: readonly ConfigurableShortcutGroup[],
  bindings: ShortcutBindingMap,
  apple: boolean,
): readonly ConfigurableShortcutGroup[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return groups;
  return groups
    .map((group) => ({
      ...group,
      items: group.items.filter((id) => {
        const meta = CONFIGURABLE_SHORTCUT_META[id];
        const allKeys = [...bindings[id], ...(meta.extraKeys ?? [])];
        return matchesQuery(needle, meta.label(), allKeys, apple);
      }),
    }))
    .filter((group) => group.items.length > 0);
}

export function filterFixedShortcuts(
  query: string,
  rows: readonly ShortcutRow[],
  apple: boolean,
): readonly ShortcutRow[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return rows;
  return rows.filter((row) => matchesQuery(needle, row.label(), row.keys, apple));
}
