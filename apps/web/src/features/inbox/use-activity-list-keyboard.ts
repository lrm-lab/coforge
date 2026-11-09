import { type FocusEvent, type KeyboardEvent, useCallback, useMemo, useState } from "react";

import type { ActivityInboxItem } from "#src/server/inbox/activity-inbox.server";
import type { ActivityItemActions } from "./use-activity-item-actions";

/** The attribute the row's `li` carries its item's key in (`data-activity-row`). */
const ACTIVITY_ROW_ATTRIBUTE = "data-activity-row";

/**
 * The keyboard of the Activity list. Selection is focus: the selected row's link has it, so the
 * focus ring and Enter (which opens the row like a click) come from the link itself. Only that
 * row is a tab stop, so Tab enters the list once and leaves it again. Up and Down (or k and j)
 * move the selection, E marks the row Done and moves it to the next row, R reads or unreads it.
 * The handlers belong on the list's container: keys typed in a field, or inside a menu or popup
 * that opened from a row, are left alone.
 */
export function useActivityListKeyboard(items: ActivityInboxItem[], actions: ActivityItemActions) {
  const [selected, setSelected] = useState<string>();
  const keys = useMemo(() => items.map((item) => item.key), [items]);
  // A selected row that left the list (Done, another view) hands the tab stop back to the first.
  const tabStopKey = selected !== undefined && keys.includes(selected) ? selected : keys[0];

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
      const key = row.getAttribute(ACTIVITY_ROW_ATTRIBUTE);
      const at = keys.findIndex((candidate) => candidate === key);
      const item = items[at];
      if (!item) return;
      const focusRow = (nextKey: string | undefined) => {
        if (nextKey === undefined) return;
        const link = [...event.currentTarget.querySelectorAll(`[${ACTIVITY_ROW_ATTRIBUTE}]`)]
          .find((candidate) => candidate.getAttribute(ACTIVITY_ROW_ATTRIBUTE) === nextKey)
          ?.querySelector<HTMLElement>("a");
        link?.focus();
      };
      switch (event.key) {
        case "ArrowDown":
        case "j":
          focusRow(keys[at + 1]);
          break;
        case "ArrowUp":
        case "k":
          focusRow(keys[at - 1]);
          break;
        case "e":
        case "E":
          if (event.shiftKey || event.repeat) return;
          // Focus moves first: the row is gone as soon as Done starts, and its focus with it.
          focusRow(keys[at + 1] ?? keys[at - 1]);
          actions.done(item);
          break;
        case "r":
        case "R":
          if (event.shiftKey || event.repeat) return;
          // A thread or a Task has no unread mark to set, only a read to give.
          if (item.unreadCount > 0) actions.read(item);
          else if (!item.thread && !item.task) actions.unread(item);
          break;
        default:
          return;
      }
      event.preventDefault();
    },
    [actions, items, keys],
  );

  return { tabStopKey, listProps: { onFocus, onKeyDown } };
}

function rowOf(element: Element) {
  return element.closest<HTMLElement>(`[${ACTIVITY_ROW_ATTRIBUTE}]`);
}

function isTyping(element: HTMLElement) {
  return element.isContentEditable || element.closest("input, textarea, select") !== null;
}
