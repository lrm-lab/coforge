import { createIsomorphicFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";

import { timeZoneFromCookies } from "#src/lib/time-zone-cookie";

/**
 * The browser's zone as its cookie last recorded it (`time-zone-cookie.ts`): from the request on
 * the server, from `document.cookie` when the loader runs in the browser (a navigation inside the
 * app). Both read through `timeZoneFromCookies`, so a navigation never loses what the server had.
 */
export const loadCookieTimeZone = createIsomorphicFn()
  .server(() => timeZoneFromCookies(getRequest().headers.get("cookie") ?? undefined))
  .client(() => timeZoneFromCookies(document.cookie));
