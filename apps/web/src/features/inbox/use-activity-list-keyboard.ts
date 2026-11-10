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
 * `keys` is every row's key in page order; `items` the inbox items among them, for E and R.
 */
export function useActivityListKeyboard(
  keys: readonly string[],
  items: readonly ActivityInboxItem[],
  actions: ActivityItemActions,
) {
  const [selected, setSelected] = useState<string>();
  // A selected row that left the list (Done, another view) hands the tab stop back to the first.
  const tabStopKey = selected !== undefined && keys.includes(selected) ? selected : keys[0];
  const tabStop = useRef(tabStopKey);
  tabStop.current = tabStopKey;

  const onFocus = useCallback((event: FocusEvent<HTMLElement>) => {
    const key = rowOf(event.target)?.getAttribute(ACTIVITY_ROW_ATTRIBUTE);
    if (key) setSelected(key);
  }, []);

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      const target = event.target as HTMLElement;
      const row = rowOf(target);
      if (!row || !event.currentTarget.contains(row)) return;
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTyping(target)) return;
      // The rows as laid out, so the walk follows the page whatever section a row is in.
      const laidOut = [
        ...event.currentTarget.querySelectorAll<HTMLElement>(`[${ACTIVITY_ROW_ATTRIBUTE}]`),
      ];
      const at = laidOut.indexOf(row);
      const focusRow = (next: HTMLElement | undefined) =>
        next?.querySelector<HTMLElement>("a")?.focus();
      const key = row.getAttribute(ACTIVITY_ROW_ATTRIBUTE);
      const item = items.find((candidate) => candidate.key === key);
      switch (event.key) {
        case "ArrowDown":
        case "j":
          focusRow(laidOut[at + 1]);
          break;
        case "ArrowUp":
        case "k":
          focusRow(laidOut[at - 1]);
          break;
        case "e":
        case "E":
          if (!item || event.shiftKey || event.repeat) return;
          // Focus moves first: the row is gone as soon as Done starts, and its focus with it.
          focusRow(laidOut[at + 1] ?? laidOut[at - 1]);
          actions.done(item);
          break;
        case "r":
        case "R":
          if (!item || event.shiftKey || event.repeat) return;
          // A thread or a Task has no unread mark to set, only a read to give.
          if (item.unreadCount > 0) actions.read(item);
          else if (!item.thread && !item.task) actions.unread(item);
          break;
        default:
          return;
      }
      event.preventDefault();
    },
    [actions, items],
  );

  // Down from the page itself (nothing focused) enters the list too.
  useEffect(() => {
    const onDocumentKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.target !== document.body) return;
      if (enterList(event, document, tabStop.current)) event.preventDefault();
    };
    document.addEventListener("keydown", onDocumentKeyDown);
    return () => document.removeEventListener("keydown", onDocumentKeyDown);
  }, []);

  /** Down from the header above the rows (the filter tabs) enters the list. */
  const onHeaderKeyDown = useCallback((event: KeyboardEvent<HTMLElement>) => {
    const target = event.target as HTMLElement;
    const rows = event.currentTarget.querySelector(`[${ACTIVITY_ROWS_ATTRIBUTE}]`);
    if (!rows || rows.contains(target) || isTyping(target)) return;
    if (enterList(event, event.currentTarget, tabStop.current)) event.preventDefault();
  }, []);

  return {
    tabStopKey,
    listProps: { onFocus, onKeyDown, [ACTIVITY_ROWS_ATTRIBUTE]: "" },
    headerProps: { onKeyDown: onHeaderKeyDown },
  };
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
  const rows = scope.querySelector(`[${ACTIVITY_ROWS_ATTRIBUTE}]`);
  if (!rows || key === undefined) return false;
  const link = [...rows.querySelectorAll(`[${ACTIVITY_ROW_ATTRIBUTE}]`)]
    .find((candidate) => candidate.getAttribute(ACTIVITY_ROW_ATTRIBUTE) === key)
    ?.querySelector<HTMLElement>("a");
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
