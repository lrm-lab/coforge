import {
  type FocusEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import {
  isRecordingShortcut,
  readShortcutBindings,
} from "#src/features/shortcuts/shortcut-bindings";
import {
  hotkeyMatchesEvent,
  type ConfigurableShortcutId,
  type KeyLikeEvent,
} from "#src/lib/hotkeys";
import { isApplePlatform } from "#src/lib/platform";
import type { ActivityInboxItem } from "#src/server/inbox/activity-inbox.server";
import { canMarkUnread } from "./activity-item-kind";
import type { ActivityItemActions } from "./use-activity-item-actions";

const ACTIVITY_ROW_ATTRIBUTE = "data-activity-row";

export const ACTIVITY_ROWS_ATTRIBUTE = "data-activity-rows";

export const waitingRowKey = (messageId: string) => `waiting:${messageId}`;

export type ActivityListFlow = {
  current: string | undefined;
  onMove: (key: string) => void;
  onEnter: (key: string) => boolean;
  onType: () => void;
};

type ActivityKeyEvent = KeyLikeEvent & { repeat?: boolean };

function matchesAction(id: ConfigurableShortcutId, event: KeyLikeEvent, apple: boolean): boolean {
  return readShortcutBindings(id).some((hotkey) => hotkeyMatchesEvent(hotkey, event, apple));
}

export function useActivityListKeyboard(
  keys: readonly string[],
  items: readonly ActivityInboxItem[],
  actions: ActivityItemActions,
  flow?: ActivityListFlow,
) {
  const [selected, setSelected] = useState<string>();
  const tabStopKey = selected !== undefined && keys.includes(selected) ? selected : keys[0];
  const tabStop = useRef(tabStopKey);
  tabStop.current = tabStopKey;
  const current = flow?.current;
  useEffect(() => {
    if (current !== undefined) setSelected(current);
  }, [current]);

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

  const itemsRef = useRef(items);
  itemsRef.current = items;
  const flowRef = useRef(flow);
  flowRef.current = flow;

  const act = useCallback(
    (event: ActivityKeyEvent, row: HTMLElement, list: ParentNode) => {
      const laidOut = [...list.querySelectorAll<HTMLElement>(`[${ACTIVITY_ROW_ATTRIBUTE}]`)];
      const at = laidOut.indexOf(row);
      const moveTo = (next: HTMLElement | undefined) => {
        const key = next?.getAttribute(ACTIVITY_ROW_ATTRIBUTE);
        if (!next || !key) return;
        next.querySelector<HTMLElement>("a")?.focus();
        flowRef.current?.onMove(key);
      };
      const key = row.getAttribute(ACTIVITY_ROW_ATTRIBUTE);
      const item = itemsRef.current.find((candidate) => candidate.key === key);
      const apple = isApplePlatform();
      if (
        (event.key === "ArrowDown" && !event.metaKey && !event.ctrlKey && !event.altKey) ||
        matchesAction("activityNext", event, apple)
      ) {
        moveTo(laidOut[at + 1]);
        return true;
      }
      if (
        (event.key === "ArrowUp" && !event.metaKey && !event.ctrlKey && !event.altKey) ||
        matchesAction("activityPrev", event, apple)
      ) {
        moveTo(laidOut[at - 1]);
        return true;
      }
      if (matchesAction("activityDone", event, apple)) {
        if (!item || event.repeat) return false;
        moveTo(laidOut[at + 1] ?? laidOut[at - 1]);
        actions.done(item);
        return true;
      }
      if (matchesAction("activityRead", event, apple)) {
        if (!item || event.repeat) return false;
        if (item.unreadCount > 0) actions.read(item);
        else if (canMarkUnread(item)) actions.unread(item);
        return true;
      }
      return false;
    },
    [actions],
  );

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      const target = event.target as HTMLElement;
      const row = rowOf(target);
      if (!row || !event.currentTarget.contains(row)) return;
      if (event.defaultPrevented || isRecordingShortcut()) return;
      if (isTyping(target)) return;
      if (act(event, row, event.currentTarget)) event.preventDefault();
      else startMessage(event);
    },
    [act, startMessage],
  );

  const onKeyDownCapture = useCallback((event: KeyboardEvent<HTMLElement>) => {
    const activeFlow = flowRef.current;
    if (!activeFlow || event.key !== "Enter" || event.defaultPrevented) return;
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    const target = event.target as HTMLElement;
    const row = rowOf(target);
    const key = row?.getAttribute(ACTIVITY_ROW_ATTRIBUTE);
    if (!key || target !== row?.querySelector("a")) return;
    if (!activeFlow.onEnter(key)) return;
    event.preventDefault();
    event.stopPropagation();
  }, []);

  const onPaneKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      const target = event.target as HTMLElement;
      if (isTyping(target) || target.closest(POPUP_ROLES)) return;
      startMessage(event);
    },
    [startMessage],
  );

  const actOnSelected = useCallback(
    (event: ActivityKeyEvent) => {
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

  useEffect(() => {
    const onDocumentKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.target !== document.body || isRecordingShortcut()) return;
      if (enterList(event, document, tabStop.current)) event.preventDefault();
      else startMessage(event);
    };
    document.addEventListener("keydown", onDocumentKeyDown);
    return () => document.removeEventListener("keydown", onDocumentKeyDown);
  }, [startMessage]);

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

const RESERVED_SHORTCUT_IDS: readonly ConfigurableShortcutId[] = [
  "shortcuts",
  "search",
  "sidebar",
  "activityNext",
  "activityPrev",
  "activityDone",
  "activityRead",
];

function startsMessage(
  event: Pick<
    globalThis.KeyboardEvent,
    "key" | "code" | "defaultPrevented" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey"
  >,
) {
  if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return false;
  const { key } = event;
  if (key.length !== 1 || key.trim() === "") return false;
  const apple = isApplePlatform();
  return !RESERVED_SHORTCUT_IDS.some((id) => matchesAction(id, event, apple));
}

const POPUP_ROLES = '[role="menu"], [role="listbox"], [role="dialog"], [role="alertdialog"]';

function selectedRow(scope: ParentNode, key: string | undefined) {
  if (key === undefined) return undefined;
  const rows = scope.querySelector(`[${ACTIVITY_ROWS_ATTRIBUTE}]`);
  return [...(rows?.querySelectorAll<HTMLElement>(`[${ACTIVITY_ROW_ATTRIBUTE}]`) ?? [])].find(
    (candidate) => candidate.getAttribute(ACTIVITY_ROW_ATTRIBUTE) === key,
  );
}

function enterList(
  event: Pick<
    globalThis.KeyboardEvent,
    "key" | "code" | "defaultPrevented" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey"
  >,
  scope: ParentNode,
  key: string | undefined,
) {
  if (event.defaultPrevented) return false;
  const apple = isApplePlatform();
  const matchesNext =
    (event.key === "ArrowDown" && !event.metaKey && !event.ctrlKey && !event.altKey) ||
    matchesAction("activityNext", event, apple);
  if (!matchesNext) return false;
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
