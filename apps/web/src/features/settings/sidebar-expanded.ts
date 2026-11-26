import { bootFragment } from "./boot-fragment";
import {
  DEVICE_FLAG_HIDDEN,
  DEVICE_FLAG_SHOWN,
  readDeviceFlag,
  writeDeviceFlag,
} from "./device-flag";
import { writeSidebarLayoutCookie } from "./sidebar-layout-cookie";

const STORAGE_KEY = "coforge-sidebar-expanded";
const COLLAPSED_CLASS = "sidebar-collapsed";
const EXPANDED_CLASS = "sidebar-expanded";

export const SIDEBAR_EXPANDED_BOOT =
  bootFragment({
    key: STORAGE_KEY,
    token: DEVICE_FLAG_HIDDEN,
    className: COLLAPSED_CLASS,
  }) +
  bootFragment({
    key: STORAGE_KEY,
    token: DEVICE_FLAG_SHOWN,
    className: EXPANDED_CLASS,
  });

export function readSidebarExpanded(): boolean {
  return readDeviceFlag(STORAGE_KEY);
}

export function isSidebarExpanded(): boolean {
  const { classList } = document.documentElement;
  if (classList.contains(COLLAPSED_CLASS)) return false;
  if (classList.contains(EXPANDED_CLASS)) return true;
  return document.querySelector("[data-sidebar-default-rail]") === null;
}

const listeners = new Set<(expanded: boolean) => void>();

export function subscribeSidebarExpanded(listener: (expanded: boolean) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function writeSidebarExpanded(expanded: boolean) {
  writeDeviceFlag(STORAGE_KEY, expanded);
  writeSidebarLayoutCookie({ expanded });
  document.documentElement.classList.toggle(COLLAPSED_CLASS, !expanded);
  document.documentElement.classList.toggle(EXPANDED_CLASS, expanded);
  for (const listener of listeners) listener(expanded);
}
