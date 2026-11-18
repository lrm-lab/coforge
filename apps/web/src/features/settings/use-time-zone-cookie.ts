import { useEffect } from "react";

import { browserTimeZone } from "#src/lib/dates";
import { timeZoneCookieUpdate } from "#src/lib/time-zone-cookie";
import { recordObservedTimeZone } from "./settings.functions";

export function shouldRecordObservedTimeZone(
  browserZone: string | null | undefined,
  serverObservedZone: string | null | undefined,
): browserZone is string {
  return Boolean(browserZone && browserZone !== serverObservedZone);
}

/**
 * Records the browser's zone in its cookie (`time-zone-cookie.ts`) for the next server render,
 * once per page load and only when it changed. Mounted once by the signed-in layout.
 */
export function useTimeZoneCookie(serverObservedZone: string | null | undefined) {
  useEffect(() => {
    const zone = browserTimeZone();
    const cookie = timeZoneCookieUpdate(
      zone,
      document.cookie,
      window.location.protocol === "https:",
    );
    if (cookie) document.cookie = cookie;
    if (shouldRecordObservedTimeZone(zone, serverObservedZone)) {
      void recordObservedTimeZone({ data: { timeZone: zone } }).catch(() => undefined);
    }
  }, [serverObservedZone]);
}
