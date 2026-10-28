import { useCallback, useEffect, useRef, useState } from "react";

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

/**
 * `notificationsAskable` for this page, `false` until it is known: nothing is read while Chrome
 * prerenders the page (permissions there read as not yet asked), and the answer follows the
 * permission's own change events. `recheck` reads it again, after the page asked for permission.
 */
export function useNotificationsAskable(): [askable: boolean, recheck: () => void] {
  const [askable, setAskable] = useState(false);
  // A live record: its `state` follows the permission, so a later read needs no new query.
  const status = useRef<PermissionStatus | undefined>(undefined);
  const read = useCallback(
    () => setAskable(notificationsAskable(browserNotificationPermission(), status.current?.state)),
    [],
  );

  useEffect(() => {
    let cancelled = false;
    const start = async () => {
      try {
        const queried = await navigator.permissions.query({ name: "notifications" });
        if (cancelled) return;
        status.current = queried;
        queried.addEventListener("change", read);
      } catch {
        // No Permissions API answer for notifications: `Notification.permission` alone decides.
      }
      if (cancelled) return;
      read();
      // Without a Permissions API answer there is no change event: coming back to the page re-reads.
      window.addEventListener("focus", read);
    };
    const activate = () => void start();
    if ((document as PrerenderingDocument).prerendering)
      document.addEventListener("prerenderingchange", activate);
    else activate();
    return () => {
      cancelled = true;
      window.removeEventListener("focus", read);
      document.removeEventListener("prerenderingchange", activate);
      status.current?.removeEventListener("change", read);
    };
  }, [read]);

  return [askable, read];
}
