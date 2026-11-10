import { browserCookie, cookiePairs } from "./browser-cookie";
import { isValidTimeZone } from "./dates";

/**
 * The browser's time zone, written by the page so the next server render knows it (task #68): a
 * list grouped by day (Activity) can then be grouped already on the server, instead of after
 * hydration with a jump. Not secret; not `HttpOnly`, since the page writes it.
 */
export const TIME_ZONE_COOKIE = "coforge_tz";

const ONE_YEAR_SECONDS = 365 * 24 * 60 * 60;

/** IANA names run to ~30 characters; anything far longer is not one, and is not parsed. */
const MAX_ZONE_LENGTH = 64;

/**
 * The zone a `Cookie` header (or `document.cookie`) carries, if it names a valid one: the server
 * render and a loader run in the browser both read it through here, so they agree.
 */
export function timeZoneFromCookies(cookies: string | undefined): string | undefined {
  const raw = cookiePairs(cookies).find(([name]) => name === TIME_ZONE_COOKIE)?.[1];
  if (!raw || raw.length > MAX_ZONE_LENGTH * 3) return undefined;
  let zone: string;
  try {
    zone = decodeURIComponent(raw);
  } catch {
    return undefined;
  }
  return zone.length <= MAX_ZONE_LENGTH && isValidTimeZone(zone) ? zone : undefined;
}

/**
 * The `document.cookie` string recording `zone`, or `undefined` when `cookies` already holds it:
 * the page writes only on a change, not on every load.
 */
export function timeZoneCookieUpdate(
  zone: string | undefined,
  cookies: string | undefined,
  secure: boolean,
): string | undefined {
  if (!zone || zone.length > MAX_ZONE_LENGTH || !isValidTimeZone(zone)) return undefined;
  if (timeZoneFromCookies(cookies) === zone) return undefined;
  return browserCookie(TIME_ZONE_COOKIE, zone, ONE_YEAR_SECONDS, secure);
}
