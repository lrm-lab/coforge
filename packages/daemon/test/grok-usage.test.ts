import { expect, test } from "bun:test";
import { readGrokUsage } from "@lrm/coforge-anvil";
import { grokRuntimeHost } from "#src/code-agent/grok/host";
import { anvilRuntimeFixtures } from "./fixtures/anvil-runtime";
const fixture = [process.execPath, anvilRuntimeFixtures.grokUsage];
const billing = (config: Record<string, unknown>) => ({ subscription_tier: "pro", config });
const read = (value: unknown) =>
  readGrokUsage(
    process.cwd(),
    {
      command: fixture,
      environment: {
        COFORGE_GROK_BILLING: JSON.stringify(value),
      },
    },
    grokRuntimeHost,
  );

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
