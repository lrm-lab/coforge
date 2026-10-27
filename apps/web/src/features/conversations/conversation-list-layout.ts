import { useEffect, useState, useSyncExternalStore } from "react";
import { browserLocalStorage } from "#src/features/browser-local-storage";
import { readDeviceFlag, writeDeviceFlag } from "#src/features/settings/device-flag";
import { isApplePlatform } from "#src/lib/platform";
import {
  LIST_COLLAPSED_CLASS,
  LIST_VISIBLE_KEY,
  LIST_WIDTH_DEFAULT,
  LIST_WIDTH_KEY,
  LIST_WIDTH_PROPERTY,
  clampListWidth,
  isListToggleShortcut,
  parseListWidth,
} from "./conversation-list-width";

type ListLayout = { width: number; collapsed: boolean };

/** What the server renders and the browser hydrates with: the stored values only reach the markup
 * through the class and property the boot script set on `<html>`. */
const SERVER_LAYOUT: ListLayout = { width: LIST_WIDTH_DEFAULT, collapsed: false };

let current: ListLayout | undefined;
const listeners = new Set<() => void>();

function readStoredLayout(): ListLayout {
  let width: number | undefined;
  try {
    width = parseListWidth(browserLocalStorage()?.getItem(LIST_WIDTH_KEY) ?? null);
  } catch {
    // Blocked storage keeps the default.
  }
  return { width: width ?? LIST_WIDTH_DEFAULT, collapsed: !readDeviceFlag(LIST_VISIBLE_KEY) };
}

export function getListLayout(): ListLayout {
  return (current ??= readStoredLayout());
}

/** Shows `next` now, on the page and to its readers, without keeping it: a drag in progress. The
 * class and property on `<html>` are what the column's CSS follows, as they were at boot. */
export function applyListLayout(next: ListLayout) {
  const previous = getListLayout();
  if (previous.width === next.width && previous.collapsed === next.collapsed) return;
  current = next;
  const root = document.documentElement;
  root.classList.toggle(LIST_COLLAPSED_CLASS, next.collapsed);
  root.style.setProperty(LIST_WIDTH_PROPERTY, `${next.width}px`);
  for (const listener of listeners) listener();
}

/** Keeps what is showing as this device's preference. A blocked storage is not an error: this page
 * still follows it. */
export function commitListLayout() {
  const { width, collapsed } = getListLayout();
  writeDeviceFlag(LIST_VISIBLE_KEY, !collapsed);
  try {
    browserLocalStorage()?.setItem(LIST_WIDTH_KEY, String(Math.round(width)));
  } catch {
    // Private mode or blocked storage.
  }
}

export function setListWidth(width: number) {
  applyListLayout({ width: clampListWidth(width), collapsed: false });
  commitListLayout();
}

/** Re-reads the stored preference: this page's copy is stale when another tab changed it while no
 * reader was subscribed. */
export function refreshListLayout() {
  applyListLayout(readStoredLayout());
}

/** The first visible element matching `selector`: a button in a hidden column is not one. */
function visible(selector: string): HTMLElement | undefined {
  return [...document.querySelectorAll<HTMLElement>(selector)].find(
    (element) => element.getClientRects().length > 0,
  );
}

/** Collapses or expands the list and keeps it. The control that had focus is hidden by this, so
 * focus moves to the one that undoes it, only when it was there: a press while typing in the
 * composer leaves focus in the composer. */
export function setListCollapsed(collapsed: boolean) {
  refreshListLayout();
  const focus = document.activeElement;
  const hadFocus = focus?.closest(collapsed ? "[data-conversation-list]" : "[data-expand-list]");
  applyListLayout({ width: getListLayout().width, collapsed });
  commitListLayout();
  if (hadFocus)
    (collapsed
      ? visible("[data-expand-list]")
      : (visible("[data-collapse-list]") ?? visible("[role=separator][aria-orientation=vertical]"))
    )?.focus();
}

function subscribe(listener: () => void) {
  // Changes made in another tab while nothing listened are caught up on here.
  refreshListLayout();
  listeners.add(listener);
  // Another tab changed a preference: follow it.
  const onStorage = (event: StorageEvent) => {
    if (event.key !== null && event.key !== LIST_WIDTH_KEY && event.key !== LIST_VISIBLE_KEY)
      return;
    applyListLayout(readStoredLayout());
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function useListLayout(): ListLayout {
  return useSyncExternalStore(subscribe, getListLayout, () => SERVER_LAYOUT);
}

/** The collapse/expand shortcut as the tooltips show it; `undefined` until the platform is known. */
export function useListShortcutLabel(): string | undefined {
  // Read after mount: the server render cannot know the viewer's platform.
  const [label, setLabel] = useState<string>();
  useEffect(() => setLabel(isApplePlatform() ? "⌘\\" : "Ctrl+\\"), []);
  return label;
}

/** Cmd/Ctrl+\ toggles the list, even while typing in the composer. Only a press it handles is
 * prevented, so the key is the browser's everywhere else. */
export function useListShortcut(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isListToggleShortcut(event, isApplePlatform())) return;
      event.preventDefault();
      refreshListLayout();
      setListCollapsed(!getListLayout().collapsed);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enabled]);
}
