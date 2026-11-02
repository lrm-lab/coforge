import { fixtureGrokHost } from "./fixtures/grok-host";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { readGrokUsage } from "@lrm/coforge-anvil/grok";
import { UsageUnavailableError, UsageUnsupportedError } from "@lrm/coforge-anvil";

const fixture = [process.execPath, join(import.meta.dir, "fixtures/grok-usage-fixture.ts")];
const billing = (config: Record<string, unknown>) => ({ subscription_tier: "pro", config });
const read = (value: unknown, error?: unknown) =>
  readGrokUsage(
    process.cwd(),
    {
      command: fixture,
      environment: {
        COFORGE_GROK_BILLING: JSON.stringify(value),
        ...(error ? { COFORGE_GROK_USAGE_ERROR: JSON.stringify(error) } : {}),
      },
    },
    fixtureGrokHost,
  );

test("derives usage and reports pay-as-you-go", async () => {
  const snapshot = await read(
    billing({ used: 15, monthlyLimit: 20, onDemandCap: { val: 10 }, onDemandUsed: { val: 2.5 } }),
  );
  expect(snapshot?.primary?.usedPercent).toBe(75);
  expect(snapshot?.secondary).toMatchObject({ usedPercent: 25 });
});

test("pay-as-you-go falls back to legacy overage when onDemandUsed is omitted", async () => {
  const snapshot = await read(billing({ used: 25, monthlyLimit: 20, onDemandCap: { val: 10 } }));
  // over = 25 - 20 = 5; cap = 10 -> 50%
  expect(snapshot?.primary?.usedPercent).toBe(100);
  expect(snapshot?.secondary).toMatchObject({ usedPercent: 50 });
  const payAsYouGoBucket = snapshot?.officialGroups?.[0]?.buckets.find(
    (bucket) => bucket.name === "Pay-as-you-go",
  );
  expect(payAsYouGoBucket).toMatchObject({
    usedPercent: 50,
    status: "ok",
    window: "onDemand",
  });
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

test("parses Grok 1.0.70 unified billing with creditUsagePercent", async () => {
  const snapshot = await read({
    subscription_tier: "SuperGrok Plus",
    config: {
      creditUsagePercent: 57.0,
      currentPeriod: {
        type: "USAGE_PERIOD_TYPE_WEEKLY",
        start: "2026-10-27T02:43:31.116+00:00",
        end: "2026-11-03T02:43:31.116+00:00",
      },
      prepaidBalance: { val: 0 },
      isUnifiedBillingUser: true,
      billingPeriodStart: "2026-10-27T02:43:31.116+00:00",
      billingPeriodEnd: "2026-11-03T02:43:31.116+00:00",
    },
  });
  expect(snapshot?.primary).toMatchObject({
    id: "grok-weekly-included-usage",
    usedPercent: 57,
    status: "ok",
    windowDurationMinutes: 10_080,
  });
  expect(snapshot?.planType).toBe("SuperGrok Plus");
  expect(snapshot?.officialGroups?.[0]?.buckets).toEqual([
    {
      name: "Weekly included usage",
      window: "USAGE_PERIOD_TYPE_WEEKLY",
      usedPercent: 57,
      status: "ok",
      windowDurationMinutes: 10_080,
      resetsAt: "2026-11-03T02:43:31.116Z",
    },
  ]);
});

test("a unified-billing account defaults omitted usage metrics to 0%", async () => {
  // When Grok's unified billing response returns no usage metrics (no creditUsagePercent,
  // used, or monthlyLimit), Raft defaults the usage to 0% instead of parse_unavailable.
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
  expect(snapshot?.primary).toMatchObject({
    id: "grok-weekly-included-usage",
    usedPercent: 0,
    status: "ok",
    windowDurationMinutes: 10_080,
    resetsAt: "2026-10-04T14:19:56.652Z",
  });
  expect(snapshot?.planType).toBe("X Premium");
  expect(snapshot?.officialGroups?.[0]?.buckets).toEqual([
    {
      name: "Weekly included usage",
      window: "USAGE_PERIOD_TYPE_WEEKLY",
      status: "ok",
      usedPercent: 0,
      windowDurationMinutes: 10_080,
      resetsAt: "2026-10-04T14:19:56.652Z",
    },
  ]);
});

test("prepaidBalance prevents rate limiting when usage is 100% and does not create a bucket", async () => {
  const snapshotWithBalance = await read({
    subscription_tier: "SuperGrok",
    config: {
      creditUsagePercent: 100,
      prepaidBalance: { val: 25 },
      isUnifiedBillingUser: true,
    },
  });
  expect(snapshotWithBalance?.health).toBe("ok");
  expect(
    snapshotWithBalance?.officialGroups?.[0]?.buckets.some((b) => b.window === "prepaidBalance"),
  ).toBe(false);

  const snapshotExhausted = await read({
    subscription_tier: "SuperGrok",
    config: {
      creditUsagePercent: 100,
      prepaidBalance: { val: 0 },
      isUnifiedBillingUser: true,
    },
  });
  expect(snapshotExhausted?.health).toBe("rate_limited");
});

test("a unified-billing account shows onDemand when cap is greater than 0", async () => {
  const snapshot = await read({
    config: {
      currentPeriod: {
        type: "USAGE_PERIOD_TYPE_MONTHLY",
        end: "2026-10-04T14:19:56.652919+00:00",
      },
      onDemandCap: { val: 5 },
      onDemandUsed: { val: 1 },
      isUnifiedBillingUser: true,
    },
  });
  expect(snapshot?.primary).toMatchObject({
    id: "grok-monthly-included-usage",
    usedPercent: 0,
    status: "ok",
  });
  expect(snapshot?.secondary).toMatchObject({
    id: "grok-pay-as-you-go",
    usedPercent: 20,
    status: "ok",
  });
  expect(snapshot?.officialGroups?.[0]?.buckets).toEqual([
    {
      name: "Monthly included usage",
      window: "USAGE_PERIOD_TYPE_MONTHLY",
      usedPercent: 0,
      status: "ok",
      windowDurationMinutes: 43_200,
      resetsAt: "2026-10-04T14:19:56.652Z",
    },
    {
      name: "Pay-as-you-go",
      window: "onDemand",
      usedPercent: 20,
      status: "ok",
      windowDurationMinutes: 43_200,
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
