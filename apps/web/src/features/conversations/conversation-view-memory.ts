import { useSyncExternalStore } from "react";

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
