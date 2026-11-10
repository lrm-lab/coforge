import { useEffect } from "react";

import { browserTimeZone } from "#src/lib/dates";
import { timeZoneCookieUpdate } from "#src/lib/time-zone-cookie";

/**
 * Records the browser's zone in its cookie (`time-zone-cookie.ts`) for the next server render,
 * once per page load and only when it changed. Mounted once by the signed-in layout.
 */
export function useTimeZoneCookie() {
  useEffect(() => {
    const cookie = timeZoneCookieUpdate(
      browserTimeZone(),
      document.cookie,
      window.location.protocol === "https:",
    );
    if (cookie) document.cookie = cookie;
  }, []);
}
