import { expect, test } from "bun:test";
import {
  TIME_ZONE_COOKIE,
  timeZoneCookieUpdate,
  timeZoneFromCookies,
} from "#src/lib/time-zone-cookie";

test("the zone is read from a Cookie header or document.cookie, whatever else it holds", () => {
  expect(timeZoneFromCookies(`a=1; ${TIME_ZONE_COOKIE}=Asia%2FKolkata; b=2`)).toBe("Asia/Kolkata");
  expect(timeZoneFromCookies(`${TIME_ZONE_COOKIE}=Pacific/Tongatapu`)).toBe("Pacific/Tongatapu");
  expect(timeZoneFromCookies(`${TIME_ZONE_COOKIE}=UTC`)).toBe("UTC");
});

test("a missing, invalid, malformed or oversized zone reads as none", () => {
  expect(timeZoneFromCookies(undefined)).toBeUndefined();
  expect(timeZoneFromCookies("")).toBeUndefined();
  expect(timeZoneFromCookies(`${TIME_ZONE_COOKIE}=`)).toBeUndefined();
  expect(timeZoneFromCookies(`${TIME_ZONE_COOKIE}=Mars%2FOlympus`)).toBeUndefined();
  expect(timeZoneFromCookies(`${TIME_ZONE_COOKIE}=%E0%A4%A`)).toBeUndefined();
  expect(timeZoneFromCookies(`${TIME_ZONE_COOKIE}=${"A".repeat(5000)}`)).toBeUndefined();
  expect(
    timeZoneFromCookies(`${TIME_ZONE_COOKIE}=${encodeURIComponent("<script>")}`),
  ).toBeUndefined();
});

test("the page writes the cookie only when the zone changed, readable by script, for a year", () => {
  expect(timeZoneCookieUpdate("Asia/Kolkata", `${TIME_ZONE_COOKIE}=Asia%2FKolkata`, true)).toBe(
    undefined,
  );
  const written = timeZoneCookieUpdate("Asia/Kolkata", `${TIME_ZONE_COOKIE}=UTC`, true)!;
  expect(written).toBe(
    `${TIME_ZONE_COOKIE}=Asia%2FKolkata; Path=/; Max-Age=31536000; SameSite=Lax; Secure`,
  );
  expect(written).not.toContain("HttpOnly");
  expect(timeZoneCookieUpdate("Asia/Kolkata", undefined, false)).not.toContain("Secure");
  expect(timeZoneCookieUpdate(undefined, undefined, false)).toBeUndefined();
  expect(timeZoneCookieUpdate("Mars/Olympus", undefined, false)).toBeUndefined();
});
