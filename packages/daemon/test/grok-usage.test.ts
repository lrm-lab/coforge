import { join } from "node:path";
import { expect, test } from "bun:test";
import { readGrokUsage } from "#src/code-agent/grok/usage";
import { UsageUnavailableError, UsageUnsupportedError } from "#src/code-agent/contract";

const fixture = [process.execPath, join(import.meta.dir, "fixtures/grok-usage-fixture.ts")];
const billing = (config: Record<string, unknown>) => ({ subscription_tier: "pro", config });
const read = (value: unknown, error?: unknown) =>
  readGrokUsage(process.cwd(), {
    command: fixture,
    environment: {
      COFORGE_GROK_BILLING: JSON.stringify(value),
      ...(error ? { COFORGE_GROK_USAGE_ERROR: JSON.stringify(error) } : {}),
    },
  });

test("reads and projects account billing through the public reader", async () => {
  const snapshot = await read(
    billing({ creditUsagePercent: 42.5, currentPeriod: { type: "Monthly", end: 1_793_304_000 } }),
  );
  expect(snapshot).toMatchObject({
    provider: "grok",
    planType: "pro",
    accountLabel: "a****@example.com",
    health: "ok",
    primary: { usedPercent: 42.5, resetsAt: new Date(1_793_304_000 * 1000).toISOString() },
  });
});

test("derives usage and reports pay-as-you-go", async () => {
  const snapshot = await read(
    billing({ used: 15, monthlyLimit: 20, onDemandCap: { val: 10 }, onDemandUsed: { val: 2.5 } }),
  );
  expect(snapshot?.primary?.usedPercent).toBe(75);
  expect(snapshot?.secondary).toMatchObject({ usedPercent: 25 });
});

test("a bare number is not a reading: only the `{ val }` wrapper Grok sends is accepted", async () => {
  // 1.0.41 is grok's newest release, so nothing produces the bare-number form the reader used to
  // take as well; reading it would leave a second path alive that no test can stand behind.
  const snapshot = await read(
    billing({ used: 15, monthlyLimit: 20, onDemandCap: 10, onDemandUsed: 2.5 }),
  );
  expect(snapshot?.primary?.usedPercent).toBe(75);
  expect(snapshot?.secondary).toBeUndefined();
});

test.each([
  ["a weekly period", "USAGE_PERIOD_TYPE_WEEKLY", 10_080],
  ["a monthly period", "USAGE_PERIOD_TYPE_MONTHLY", 43_200],
  ["a period type it does not know", "USAGE_PERIOD_TYPE_UNSPECIFIED", 43_200],
  ["no period type", undefined, 43_200],
] as const)("the usage windows last as long as %s", async (_period, type, minutes) => {
  const snapshot = await read(
    billing({
      creditUsagePercent: 10,
      currentPeriod: { type, end: "2026-10-04T14:19:56.652919+00:00" },
      onDemandCap: { val: 10 },
      onDemandUsed: { val: 1 },
    }),
  );
  // The pay-as-you-go window resets with the credit window, so both span the same period.
  expect(snapshot?.primary?.windowDurationMinutes).toBe(minutes);
  expect(snapshot?.secondary?.windowDurationMinutes).toBe(minutes);
});

test("a unified-billing account may omit the percent and still keeps the wrapped fields", async () => {
  // The billing response Grok 1.0.41 sends for a unified-billing account: no
  // `creditUsagePercent`, no `used`/`monthlyLimit`, a weekly period, and every number wrapped.
  const snapshot = await read({
    subscription_tier: "X Premium",
    config: {
      currentPeriod: {
        type: "USAGE_PERIOD_TYPE_WEEKLY",
        start: "2026-09-27T14:19:56.652919+00:00",
        end: "2026-10-04T14:19:56.652919+00:00",
      },
      onDemandCap: { val: 0 },
      onDemandUsed: { val: 0 },
      prepaidBalance: { val: 0 },
      isUnifiedBillingUser: true,
      billingPeriodEnd: "2026-10-04T14:19:56.652919+00:00",
    },
  });
  expect(snapshot?.primary).toBeUndefined();
  expect(snapshot?.planType).toBe("X Premium");
  expect(snapshot?.officialGroups?.[0]?.buckets).toEqual([
    {
      window: "USAGE_PERIOD_TYPE_WEEKLY",
      status: "parse_unavailable",
      windowDurationMinutes: 10_080,
      resetsAt: "2026-10-04T14:19:56.652Z",
    },
    { window: "onDemand", description: "0 / 0", resetsAt: "2026-10-04T14:19:56.652Z" },
    { window: "prepaidBalance", description: "0" },
  ]);
});

test("a unified-billing account does not invent a month length or a one-sided on-demand figure", async () => {
  const snapshot = await read({
    config: {
      currentPeriod: {
        type: "USAGE_PERIOD_TYPE_MONTHLY",
        end: "2026-10-04T14:19:56.652919+00:00",
      },
      onDemandCap: { val: 5 },
      isUnifiedBillingUser: true,
    },
  });
  expect(snapshot?.primary).toBeUndefined();
  expect(snapshot?.officialGroups?.[0]?.buckets).toEqual([
    {
      window: "USAGE_PERIOD_TYPE_MONTHLY",
      status: "parse_unavailable",
      resetsAt: "2026-10-04T14:19:56.652Z",
    },
  ]);
});

test("marks exhausted account as rate limited and clamps percentages", async () => {
  const snapshot = await read(billing({ creditUsagePercent: 150 }));
  expect(snapshot).toMatchObject({
    health: "rate_limited",
    primary: { usedPercent: 100, status: "limit_reached" },
  });
});

test("maps ACP method and auth failures at the public boundary", async () => {
  await expect(read({}, { code: -32601, message: "method not found" })).rejects.toBeInstanceOf(
    UsageUnsupportedError,
  );
  await expect(read({}, { code: -32000, message: "unauthorized" })).rejects.toBeInstanceOf(
    UsageUnavailableError,
  );
});

test("propagates unknown ACP failures", async () => {
  await expect(read({}, { code: -32700, message: "parse error" })).rejects.toMatchObject({
    code: -32700,
  });
});
