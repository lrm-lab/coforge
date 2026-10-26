import { expect, test } from "bun:test";
import { readKiroUsage as parseKiroUsage, UsageUnavailableError } from "@lrm/coforge-anvil";
import { kiroUsagePayload as payload } from "./fixtures/kiro-usage";

function readKiroUsage(options: { fetch(): Promise<Response> }) {
  return parseKiroUsage({}, async () => (await options.fetch()).json());
}

test("keeps bonuses and an active free trial without turning them into a plan-only percent", async () => {
  const withBonus = await readKiroUsage({
    fetch: async () =>
      Response.json({
        ...payload,
        usageBreakdownList: [{ ...payload.usageBreakdownList[0], bonuses: [{}] }],
      }),
  });
  expect(withBonus?.primary).toBeUndefined();
  expect(withBonus?.creditUsage).toBeUndefined();
  expect(withBonus?.officialGroups?.[0]?.name).toBe("CREDIT");
  expect(withBonus?.officialGroups?.[0]?.buckets).toEqual([
    { name: "CREDIT", description: "75 / 200 + 15" },
    { window: "bonus", status: "parse_unavailable" },
  ]);
  const withTrial = await readKiroUsage({
    fetch: async () =>
      Response.json({
        ...payload,
        usageBreakdownList: [
          { ...payload.usageBreakdownList[0], freeTrialInfo: { freeTrialStatus: "ACTIVE" } },
        ],
      }),
  });
  expect(withTrial?.primary).toBeUndefined();
  expect(withTrial?.officialGroups?.[0]?.buckets[1]).toEqual({
    window: "freeTrial",
    name: "freeTrial",
    description: "ACTIVE",
  });
});

test("does not invent quota from invalid numbers or millisecond resets", async () => {
  for (const changes of [
    { currentUsageWithPrecision: -1 },
    { usageLimitWithPrecision: 0 },
    { currentUsageWithPrecision: 10, currentOveragesWithPrecision: 15 },
    { currentUsageWithPrecision: 300 },
    { nextDateReset: 1790812800000 },
  ]) {
    await expect(
      readKiroUsage({
        fetch: async () =>
          Response.json({
            ...payload,
            usageBreakdownList: [{ ...payload.usageBreakdownList[0], ...changes }],
          }),
      }),
    ).rejects.toBeInstanceOf(UsageUnavailableError);
  }
});
