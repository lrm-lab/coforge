import { useSyncExternalStore } from "react";

import { browserNotificationPermission, type BrowserNotificationPermission } from "./browser-push";

/** Chrome's Speculation Rules field, not yet in the DOM typings. */
type PrerenderingDocument = Document & { prerendering?: boolean };

/**
 * Whether this browser has yet to be asked about notifications for the site: both its permission
 * record (`navigator.permissions`, `queried`) and `Notification.permission` must say so. The
 * synchronous value alone is not trusted, since Chrome can briefly report "default" for a site it
 * allows. Without a Permissions API answer (`undefined`), the synchronous value decides.
 */
export function notificationsAskable(
  current: BrowserNotificationPermission,
  queried: PermissionState | undefined,
) {
  return current === "default" && (queried === undefined || queried === "prompt");
}

/** The page's one reading of `notificationsAskable`, shared by every banner. The permission is the
 * browser's, not a pane's: a conversation pane mounted later (opening one from Activity) shows the
 * answer in its first frame, with its composer, instead of growing the banner in once a fresh query
 * resolves and moving the conversation under the reader's finger (task #72). */
let askableNow = false;
let started = false;
// A live record: its `state` follows the permission, so a later read needs no new query.
let status: PermissionStatus | undefined;
const listeners = new Set<() => void>();

function readAskable() {
  const next = notificationsAskable(browserNotificationPermission(), status?.state);
  if (next === askableNow) return;
  askableNow = next;
  for (const listener of listeners) listener();
}

/** Reads it once for the page, from the Workspace layout on (`NotificationActivationProvider`), so
 * the answer is in before the first conversation pane mounts. Nothing is read while Chrome
 * prerenders the page (permissions there read as not yet asked); after that the permission's own
 * change events, or coming back to the page where there are none, keep it current. */
export function startReadingNotificationsAskable() {
  if (started) return;
  started = true;
  const start = async () => {
    try {
      status = await navigator.permissions.query({ name: "notifications" });
      status.addEventListener("change", readAskable);
    } catch {
      // No Permissions API answer for notifications: `Notification.permission` alone decides.
    }
    readAskable();
    // Without a Permissions API answer there is no change event: coming back to the page re-reads.
    window.addEventListener("focus", readAskable);
  };
  if ((document as PrerenderingDocument).prerendering)
    document.addEventListener("prerenderingchange", () => void start(), { once: true });
  else void start();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  startReadingNotificationsAskable();
  return () => listeners.delete(listener);
}

/**
 * `notificationsAskable` for this page, `false` until it is known and in the server render (so
 * hydration agrees on showing nothing). `recheck` reads it again, after the page asked for
 * permission.
 */
export function useNotificationsAskable(): [askable: boolean, recheck: () => void] {
  const askable = useSyncExternalStore(
    subscribe,
    () => askableNow,
    () => false,
  );
  return [askable, readAskable];
}
