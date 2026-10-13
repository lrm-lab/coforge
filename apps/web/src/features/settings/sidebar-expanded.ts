import { bootFragment } from "./boot-fragment";
import { DEVICE_FLAG_HIDDEN, readDeviceFlag, writeDeviceFlag } from "./device-flag";

const STORAGE_KEY = "coforge-sidebar-expanded";
const COLLAPSED_CLASS = "sidebar-collapsed";

/** The boot half of the same rule: `__root.tsx` runs this before paint so SSR markup never depends
 * on the class. Built by `bootFragment` from the key, the hidden value and the class above, so the
 * script and `readSidebarExpanded` cannot disagree about what "collapsed" is stored as. */
export const SIDEBAR_EXPANDED_BOOT = bootFragment({
  key: STORAGE_KEY,
  token: DEVICE_FLAG_HIDDEN,
  className: COLLAPSED_CLASS,
});

/** Per-device preference: the desktop sidebar is the full one, or collapsed to its icon rail.
 *  Expanded unless this device stored the hidden value. Applied as a class on <html> (also by the
 *  boot script), and both sidebars are always rendered, so the markup never depends on it. */
export function readSidebarExpanded(): boolean {
  return readDeviceFlag(STORAGE_KEY);
}

export function writeSidebarExpanded(expanded: boolean) {
  writeDeviceFlag(STORAGE_KEY, expanded);
  document.documentElement.classList.toggle(COLLAPSED_CLASS, !expanded);
}
