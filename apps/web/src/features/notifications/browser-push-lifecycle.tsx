import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";

import { browserNotificationPermission, syncBrowserPushSubscription } from "./browser-push";
import { subscribeBrowserPush } from "./notifications.functions";

export function BrowserPushLifecycle({
  enabled,
  publicKey,
}: {
  enabled: boolean;
  publicKey: string | null;
}) {
  const subscribe = useServerFn(subscribeBrowserPush);
  // Re-read when the tab comes back, so a permission granted elsewhere (the site settings, another
  // tab's banner) re-registers this browser without a reload, as on Raft.
  const [permission, setPermission] = useState<string>("unsupported");
  useEffect(() => {
    const refresh = () => setPermission(browserNotificationPermission());
    const onVisible = () => document.visibilityState === "visible" && refresh();
    refresh();
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  useEffect(() => {
    if (!enabled || !publicKey || permission !== "granted") return;
    syncBrowserPushSubscription(publicKey, (data) => subscribe({ data })).catch((cause) => {
      // Settings shows actionable errors; this background re-registration only leaves a trace.
      console.warn("browser push re-registration failed", cause);
    });
  }, [enabled, publicKey, permission, subscribe]);

  return null;
}
