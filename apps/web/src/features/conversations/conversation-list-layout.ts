import { useCallback, useSyncExternalStore } from "react";
import { browserLocalStorage } from "#src/features/browser-local-storage";
import { clampListWidth, parseListWidth, type ListColumn } from "./conversation-list-width";

type Store = {
  current: number | undefined;
  listeners: Set<() => void>;
};

const stores = new Map<ListColumn, Store>();

function store(column: ListColumn): Store {
  let found = stores.get(column);
  if (!found) {
    found = { current: undefined, listeners: new Set() };
    stores.set(column, found);
  }
  return found;
}

function readStoredWidth(column: ListColumn): number {
  try {
    return (
      parseListWidth(column, browserLocalStorage()?.getItem(column.key) ?? null) ??
      column.defaultWidth
    );
  } catch {
    // Blocked storage keeps the default.
    return column.defaultWidth;
  }
}

export function getListWidth(column: ListColumn): number {
  return (store(column).current ??= readStoredWidth(column));
}

/** Shows `width` now, on the page and to its readers, without keeping it: a drag in progress. The
 * property on `<html>` is what the column's CSS follows, as it was at boot. */
export function applyListWidth(column: ListColumn, width: number) {
  if (getListWidth(column) === width) return;
  const columnStore = store(column);
  columnStore.current = width;
  document.documentElement.style.setProperty(column.property, `${width}px`);
  for (const listener of columnStore.listeners) listener();
}

/** Keeps what is showing as this device's preference. A blocked storage is not an error: this page
 * still follows it. */
export function commitListWidth(column: ListColumn) {
  try {
    browserLocalStorage()?.setItem(column.key, String(Math.round(getListWidth(column))));
  } catch {
    // Private mode or blocked storage.
  }
}

export function setListWidth(column: ListColumn, width: number) {
  applyListWidth(column, clampListWidth(column, width));
  commitListWidth(column);
}

function subscribe(column: ListColumn, listener: () => void) {
  // Changes made in another tab while nothing listened are caught up on here.
  applyListWidth(column, readStoredWidth(column));
  const { listeners } = store(column);
  listeners.add(listener);
  // Another tab changed the preference: follow it.
  const onStorage = (event: StorageEvent) => {
    if (event.key !== null && event.key !== column.key) return;
    applyListWidth(column, readStoredWidth(column));
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

/** The column's width as kept; what the server renders and the browser hydrates with is the
 * default, since the stored width only reaches the markup through the property the boot script
 * set on `<html>`. */
export function useListWidth(column: ListColumn): number {
  return useSyncExternalStore(
    useCallback((listener: () => void) => subscribe(column, listener), [column]),
    () => getListWidth(column),
    () => column.defaultWidth,
  );
}
