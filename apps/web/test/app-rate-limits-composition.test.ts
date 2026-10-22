import { afterEach, expect, spyOn, test } from "bun:test";

import {
  getAppRateLimits,
  resetAppRateLimits,
} from "#src/server/app-rate-limits/app-rate-limits-composition.server";

/** Without a REDIS_URL nothing is limited, and the deployment is told once, at first use. */

const redisUrl = Bun.env.REDIS_URL;

afterEach(() => {
  if (redisUrl === undefined) delete Bun.env.REDIS_URL;
  else Bun.env.REDIS_URL = redisUrl;
  resetAppRateLimits();
});

test("no REDIS_URL admits every request and logs redis_unavailable once", async () => {
  delete Bun.env.REDIS_URL;
  resetAppRateLimits();
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const limits = getAppRateLimits();
  for (let i = 0; i < 3; i++) {
    expect(await limits.token.admit("app")).toEqual({ allowed: true });
    expect(await limits.installation.admit("installation")).toEqual({ allowed: true });
  }
  expect(warn).toHaveBeenCalledTimes(1);
  expect(JSON.parse(String(warn.mock.calls[0]![0]))).toMatchObject({
    event: "app_rate_limit:redis_unavailable",
  });
  expect(getAppRateLimits()).toBe(limits);
});
