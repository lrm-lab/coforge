import { HOTKEYS } from "#src/lib/hotkeys";
import { m } from "#src/paraglide/messages";

export type ShortcutRow = { label: () => string; keys: readonly string[] };
export type ShortcutGroup = { title: () => string; rows: readonly ShortcutRow[] };

export const SHORTCUT_GROUPS: readonly ShortcutGroup[] = [
  {
    title: m.shortcuts_group_global,
    rows: [
      { label: m.shortcuts_open, keys: [HOTKEYS.shortcuts] },
      { label: m.shortcuts_search, keys: [HOTKEYS.search] },
      { label: m.shortcuts_sidebar, keys: [HOTKEYS.sidebar] },
    ],
  },
  {
    title: m.shortcuts_group_composer,
    rows: [
      { label: m.shortcuts_send, keys: ["Enter"] },
      { label: m.shortcuts_newline, keys: ["Shift+Enter"] },
      { label: m.shortcuts_send_as_task, keys: [HOTKEYS.sendAsTask] },
      { label: m.shortcuts_mention_move, keys: ["ArrowUp", "ArrowDown"] },
      { label: m.shortcuts_mention_insert, keys: ["Enter", "Tab"] },
      { label: m.shortcuts_question_jump, keys: ["Alt+ArrowUp", "Alt+ArrowDown"] },
      { label: m.shortcuts_dialog_submit, keys: ["Mod+Enter"] },
    ],
  },
  {
    title: m.shortcuts_group_messages,
    rows: [
      { label: m.shortcuts_card_move, keys: ["ArrowUp", "ArrowDown"] },
      { label: m.shortcuts_card_pick, keys: ["1–9"] },
      { label: m.shortcuts_card_tick, keys: ["Space"] },
      { label: m.shortcuts_card_switch, keys: ["ArrowLeft", "ArrowRight"] },
      { label: m.shortcuts_card_back, keys: ["Escape"] },
      { label: m.shortcuts_leave, keys: ["Escape"] },
      { label: m.shortcuts_activity_next, keys: ["J", "ArrowDown"] },
      { label: m.shortcuts_activity_prev, keys: ["K", "ArrowUp"] },
      { label: m.shortcuts_activity_done, keys: ["E"] },
      { label: m.shortcuts_activity_read, keys: ["R"] },
    ],
  },
  {
    title: m.shortcuts_group_previews,
    rows: [
      { label: m.shortcuts_find, keys: ["Mod+F"] },
      { label: m.shortcuts_match, keys: ["Enter", "Shift+Enter"] },
      { label: m.shortcuts_comment_post, keys: ["Mod+Enter"] },
      { label: m.shortcuts_draft_switch, keys: ["ArrowUp", "ArrowDown"] },
      { label: m.shortcuts_undo, keys: ["Mod+Z"] },
      { label: m.shortcuts_redo, keys: ["Mod+Shift+Z", "Mod+Y"] },
      { label: m.shortcuts_page_switch, keys: ["ArrowLeft", "ArrowRight"] },
      { label: m.shortcuts_present_exit, keys: ["Escape"] },
    ],
  },
];
