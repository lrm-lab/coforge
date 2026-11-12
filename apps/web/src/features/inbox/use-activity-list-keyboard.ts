import {
  type FocusEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import type { ActivityInboxItem } from "#src/server/inbox/activity-inbox.server";
import type { ActivityItemActions } from "./use-activity-item-actions";

/** The attribute the row's `li` carries its item's key in (`data-activity-row`). */
const ACTIVITY_ROW_ATTRIBUTE = "data-activity-row";

/** The attribute the rows' scrolling container carries, which the keys from above it enter. */
export const ACTIVITY_ROWS_ATTRIBUTE = "data-activity-rows";

/** A waiting choice card's row key, beside the items' own (`ActivityInboxItem.key`). */
export const waitingRowKey = (messageId: string) => `waiting:${messageId}`;

/**
 * What a conversation open beside the list adds to its keyboard (Frank, 11-12): the selection
 * the keyboard moves opens its row (`onMove`), Enter on the open row goes into its composer
 * (`onEnter`, true when it did), and so does any other character typed, as in Slack, the
 * character landing there (`onType`). The selection follows the row the pane shows (`current`),
 * however it was opened, so the keys pressed in it act on that row.
 */
export type ActivityListFlow = {
  current: string | undefined;
  onMove: (key: string) => void;
  onEnter: (key: string) => boolean;
  onType: () => void;
};

/**
 * The keyboard of the Activity list. Selection is focus: the selected row's link has it, so the
 * focus ring and Enter (which opens the row like a click) come from the link itself. Only that
 * row is a tab stop, so Tab enters the list once and leaves it again. Up and Down (or k and j)
 * move the selection over every row as laid out, the waiting cards on top included; E marks an
 * item Done and moves to the next row, R reads or unreads it.
 *
 * Down (or j) from above the rows, the filter tabs or the page itself, enters the list at its
 * selected row (Frank, 11-10, task #51): the tabs run left and right, so Down is free there.
 * Keys typed in a field, or inside a menu or popup that opened from a row, are left alone.
 *
 * With `flow`, j, k and E pressed in the open conversation act on the selected row as in the list
 * (`actOnSelected`, which the pane binds), and `focusSelected` gives the caret back to that row
 * (Escape from the composer). A character that is none of the list's keys,
 * typed in the list, the conversation or the page, starts a message in the conversation.
 *
 * `keys` is every row's key in page order; `items` the inbox items among them, for E and R.
 */
export function useActivityListKeyboard(
  keys: readonly string[],
  items: readonly ActivityInboxItem[],
  actions: ActivityItemActions,
  flow?: ActivityListFlow,
) {
  const [selected, setSelected] = useState<string>();
  // A selected row that left the list (Done, another view) hands the tab stop back to the first.
  const tabStopKey = selected !== undefined && keys.includes(selected) ? selected : keys[0];
  const tabStop = useRef(tabStopKey);
  tabStop.current = tabStopKey;
  const current = flow?.current;
  useEffect(() => {
    if (current !== undefined) setSelected(current);
  }, [current]);

  /** A character typed outside a field, in flow, starts a message in the conversation. */
  const onType = flow?.onType;
  const startMessage = useCallback(
    (event: Parameters<typeof startsMessage>[0]) => {
      if (onType && startsMessage(event)) onType();
    },
    [onType],
  );

  const onFocus = useCallback((event: FocusEvent<HTMLElement>) => {
    const key = rowOf(event.target)?.getAttribute(ACTIVITY_ROW_ATTRIBUTE);
    if (key) setSelected(key);
  }, []);

  /** Runs a list key on `row`, among the rows as `list` lays them out; whether it was one. */
  const act = useCallback(
    (
      event: Pick<KeyboardEvent, "key" | "shiftKey" | "repeat">,
      row: HTMLElement,
      list: ParentNode,
    ) => {
      // The rows as laid out, so the walk follows the page whatever section a row is in.
      const laidOut = [...list.querySelectorAll<HTMLElement>(`[${ACTIVITY_ROW_ATTRIBUTE}]`)];
      const at = laidOut.indexOf(row);
      const moveTo = (next: HTMLElement | undefined) => {
        const key = next?.getAttribute(ACTIVITY_ROW_ATTRIBUTE);
        if (!next || !key) return;
        next.querySelector<HTMLElement>("a")?.focus();
        flow?.onMove(key);
      };
      const key = row.getAttribute(ACTIVITY_ROW_ATTRIBUTE);
      const item = items.find((candidate) => candidate.key === key);
      switch (event.key) {
        case "ArrowDown":
        case "j":
          moveTo(laidOut[at + 1]);
          return true;
        case "ArrowUp":
        case "k":
          moveTo(laidOut[at - 1]);
          return true;
        case "e":
        case "E":
          if (!item || event.shiftKey || event.repeat) return false;
          // Focus moves first: the row is gone as soon as Done starts, and its focus with it.
          moveTo(laidOut[at + 1] ?? laidOut[at - 1]);
          actions.done(item);
          return true;
        case "r":
        case "R":
          if (!item || event.shiftKey || event.repeat) return false;
          // A thread or a Task has no unread mark to set, only a read to give.
          if (item.unreadCount > 0) actions.read(item);
          else if (!item.thread && !item.task) actions.unread(item);
          return true;
        default:
          return false;
      }
    },
    [actions, items, flow],
  );

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      const target = event.target as HTMLElement;
      const row = rowOf(target);
      if (!row || !event.currentTarget.contains(row)) return;
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTyping(target)) return;
      if (act(event, row, event.currentTarget)) event.preventDefault();
      else startMessage(event);
    },
    [act, startMessage],
  );

  // Enter on the open row's link goes into its composer before the link can open the row again.
  const onKeyDownCapture = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      if (!flow || event.key !== "Enter" || event.defaultPrevented) return;
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      const target = event.target as HTMLElement;
      const row = rowOf(target);
      const key = row?.getAttribute(ACTIVITY_ROW_ATTRIBUTE);
      if (!key || target !== row?.querySelector("a")) return;
      if (!flow.onEnter(key)) return;
      event.preventDefault();
      event.stopPropagation();
    },
    [flow],
  );

  /** A character typed in the open conversation, outside a field or a popup, starts a message. */
  const onPaneKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      const target = event.target as HTMLElement;
      // A menu or a popup opened from the conversation reaches here through its React portal.
      if (isTyping(target) || target.closest(POPUP_ROLES)) return;
      startMessage(event);
    },
    [startMessage],
  );

  /** j, k or E pressed in the open conversation acts on the list's selected row. */
  const actOnSelected = useCallback(
    (event: Pick<KeyboardEvent, "key" | "shiftKey" | "repeat">) => {
      const row = selectedRow(document, tabStop.current);
      const list = row?.closest(`[${ACTIVITY_ROWS_ATTRIBUTE}]`);
      if (row && list) act(event, row, list);
    },
    [act],
  );

  const focusSelected = useCallback(
    () => selectedRow(document, tabStop.current)?.querySelector<HTMLElement>("a")?.focus(),
    [],
  );

  // Down from the page itself (nothing focused) enters the list too.
  useEffect(() => {
    const onDocumentKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.target !== document.body) return;
      if (enterList(event, document, tabStop.current)) event.preventDefault();
      else startMessage(event);
    };
    document.addEventListener("keydown", onDocumentKeyDown);
    return () => document.removeEventListener("keydown", onDocumentKeyDown);
  }, [startMessage]);

  /** Down from the header above the rows (the filter tabs) enters the list. */
  const onHeaderKeyDown = useCallback((event: KeyboardEvent<HTMLElement>) => {
    const target = event.target as HTMLElement;
    const rows = event.currentTarget.querySelector(`[${ACTIVITY_ROWS_ATTRIBUTE}]`);
    if (!rows || rows.contains(target) || isTyping(target)) return;
    if (enterList(event, event.currentTarget, tabStop.current)) event.preventDefault();
  }, []);

  return {
    tabStopKey,
    listProps: { onFocus, onKeyDown, onKeyDownCapture, [ACTIVITY_ROWS_ATTRIBUTE]: "" },
    headerProps: { onKeyDown: onHeaderKeyDown },
    paneProps: { onKeyDown: onPaneKeyDown },
    actOnSelected,
    focusSelected,
  };
}

/** The list's own letters, which never start a message, whether or not they acted. */
const LIST_LETTERS = new Set(["j", "k", "e", "r"]);

/**
 * A key that types a character, not a space nor one of the list's letters: focusing the composer
 * in its keydown lands the character there. Under an input method only the first letter lands
 * raw, as in Slack.
 */
function startsMessage(
  event: Pick<
    globalThis.KeyboardEvent,
    "key" | "defaultPrevented" | "metaKey" | "ctrlKey" | "altKey"
  >,
) {
  if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return false;
  const { key } = event;
  return key.length === 1 && key.trim() !== "" && !LIST_LETTERS.has(key.toLowerCase());
}

/** Where a key belongs to what is open over the page, not to the list. */
const POPUP_ROLES = '[role="menu"], [role="listbox"], [role="dialog"], [role="alertdialog"]';

/** The row at `key` within `scope`'s list. */
function selectedRow(scope: ParentNode, key: string | undefined) {
  if (key === undefined) return undefined;
  const rows = scope.querySelector(`[${ACTIVITY_ROWS_ATTRIBUTE}]`);
  return [...(rows?.querySelectorAll<HTMLElement>(`[${ACTIVITY_ROW_ATTRIBUTE}]`) ?? [])].find(
    (candidate) => candidate.getAttribute(ACTIVITY_ROW_ATTRIBUTE) === key,
  );
}

/** Focuses the list's selected row for Down (or j), if `scope` holds the list; whether it did. */
function enterList(
  event: Pick<
    globalThis.KeyboardEvent,
    "key" | "defaultPrevented" | "metaKey" | "ctrlKey" | "altKey"
  >,
  scope: ParentNode,
  key: string | undefined,
) {
  if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return false;
  if (event.key !== "ArrowDown" && event.key !== "j") return false;
  const link = selectedRow(scope, key)?.querySelector<HTMLElement>("a");
  if (!link) return false;
  link.focus();
  return true;
}

function rowOf(element: Element) {
  return element.closest<HTMLElement>(`[${ACTIVITY_ROW_ATTRIBUTE}]`);
}

function isTyping(element: HTMLElement) {
  return element.isContentEditable || element.closest("input, textarea, select") !== null;
}
