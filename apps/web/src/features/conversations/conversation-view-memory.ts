import { useCallback, useSyncExternalStore } from "react";

export type SavedPosition = { rowId: string; offset: number };

export type OpeningPosition = "jump" | "top" | "saved" | "boundary" | "latest";

const positions = new Map<string, SavedPosition>();
let expanded: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();

export function savedPosition(key: string) {
  return positions.get(key);
}

export function savePosition(key: string, position: SavedPosition | undefined) {
  if (position) positions.set(key, position);
  else positions.delete(key);
}

export function openingPosition({
  hash,
  jump,
  top,
  saved,
  boundary,
}: {
  hash: boolean;
  jump: boolean;
  top: boolean;
  saved: boolean;
  boundary: boolean;
}): OpeningPosition {
  if (hash) return "latest";
  if (jump) return "jump";
  if (top) return "top";
  if (saved) return "saved";
  if (boundary) return "boundary";
  return "latest";
}

export function toggleExpanded(key: string) {
  const next = new Set(expanded);
  if (!next.delete(key)) next.add(key);
  expanded = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot() {
  return expanded;
}

export function useExpandedMessages() {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

const NOOP_SUBSCRIBE = () => () => {};
const NOT_EXPANDED = () => false;

export function useMessageExpanded(key: string | undefined): boolean {
  return useSyncExternalStore(
    key === undefined ? NOOP_SUBSCRIBE : subscribe,
    key === undefined ? NOT_EXPANDED : () => expanded.has(key),
    key === undefined ? NOT_EXPANDED : () => expanded.has(key),
  );
}

const sendingAsTask = new Set<string>();
const sendAsTaskListeners = new Set<() => void>();

export function setSendAsTask(draftKey: string, on: boolean) {
  if (on === sendingAsTask.has(draftKey)) return;
  if (on) sendingAsTask.add(draftKey);
  else sendingAsTask.delete(draftKey);
  for (const listener of sendAsTaskListeners) listener();
}

function subscribeSendAsTask(listener: () => void) {
  sendAsTaskListeners.add(listener);
  return () => sendAsTaskListeners.delete(listener);
}

export function useSendAsTask(draftKey: string) {
  const armed = () => sendingAsTask.has(draftKey);
  const on = useSyncExternalStore(subscribeSendAsTask, armed, armed);
  const set = useCallback((next: boolean) => setSendAsTask(draftKey, next), [draftKey]);
  return [on, set] as const;
}
