import { useSyncExternalStore } from "react";
import { browserLocalStorage } from "#src/features/browser-local-storage";
import {
  LIST_WIDTH_DEFAULT,
  LIST_WIDTH_KEY,
  LIST_WIDTH_PROPERTY,
  clampListWidth,
  parseListWidth,
} from "./conversation-list-width";

/** What the server renders and the browser hydrates with: the stored width only reaches the markup
 * through the property the boot script set on `<html>`. */
const SERVER_WIDTH = LIST_WIDTH_DEFAULT;

let current: number | undefined;
const listeners = new Set<() => void>();

function readStoredWidth(): number {
  try {
    return (
      parseListWidth(browserLocalStorage()?.getItem(LIST_WIDTH_KEY) ?? null) ?? LIST_WIDTH_DEFAULT
    );
  } catch {
    // Blocked storage keeps the default.
    return LIST_WIDTH_DEFAULT;
  }
}

export function getListWidth(): number {
  return (current ??= readStoredWidth());
}

/** Shows `width` now, on the page and to its readers, without keeping it: a drag in progress. The
 * property on `<html>` is what the column's CSS follows, as it was at boot. */
export function applyListWidth(width: number) {
  if (getListWidth() === width) return;
  current = width;
  document.documentElement.style.setProperty(LIST_WIDTH_PROPERTY, `${width}px`);
  for (const listener of listeners) listener();
}

/** Keeps what is showing as this device's preference. A blocked storage is not an error: this page
 * still follows it. */
export function commitListWidth() {
  try {
    browserLocalStorage()?.setItem(LIST_WIDTH_KEY, String(Math.round(getListWidth())));
  } catch {
    // Private mode or blocked storage.
  }
}

export function setListWidth(width: number) {
  applyListWidth(clampListWidth(width));
  commitListWidth();
}

function subscribe(listener: () => void) {
  // Changes made in another tab while nothing listened are caught up on here.
  applyListWidth(readStoredWidth());
  listeners.add(listener);
  // Another tab changed the preference: follow it.
  const onStorage = (event: StorageEvent) => {
    if (event.key !== null && event.key !== LIST_WIDTH_KEY) return;
    applyListWidth(readStoredWidth());
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function useListWidth(): number {
  return useSyncExternalStore(subscribe, getListWidth, () => SERVER_WIDTH);
}
