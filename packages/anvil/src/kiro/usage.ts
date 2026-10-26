import type { UsageOfficialBucket, UsageOfficialGroup, UsageSnapshot } from "#src/contract";
import { UsageUnavailableError } from "#src/contract";
import { asRecord as record } from "#src/json-record";
import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";

/** The host returns raw usage JSON, or undefined when native credentials are unavailable. */
export type KiroUsageReader = (options: Readonly<{ timeoutMs?: number }>) => Promise<unknown>;

export async function readKiroUsage(
  options: Readonly<{ timeoutMs?: number }>,
  readResponse: KiroUsageReader,
): Promise<UsageSnapshot | null> {
  const response = await readResponse(options);
  if (response === undefined) return null;
  const result = snapshot(response);
  if (!result) throw new UsageUnavailableError();
  return result;
}

function snapshot(value: unknown): UsageSnapshot | null {
  const data = record(value);
  if (!Array.isArray(data?.usageBreakdownList)) return null;
  let invalid = false;
  const officialGroups: UsageOfficialGroup[] = [];
  for (const raw of data.usageBreakdownList) {
    const item = record(raw);
    if (!item) {
      invalid = true;
      continue;
    }
    const group = breakdownGroup(item, data);
    if (group === "invalid") invalid = true;
    else if (group) officialGroups.push(group);
  }
  if (officialGroups.length === 0) {
    if (invalid) throw new UsageUnavailableError();
    return null;
  }
  const plan = cleanCreditPlan(data);
  const title = record(data.subscriptionInfo)?.subscriptionTitle;
  return {
    provider: RUNTIME_PROVIDER.KIRO,
    ...(typeof title === "string" && title.trim() ? { planType: title } : {}),
    officialGroups,
    ...plan,
  };
}

/** Every breakdown, including its bonuses and free trial. A plan-only percent is added only
 * for one clean CREDIT row. Bonuses or an ACTIVE trial stay on the snapshot and do not reject it. */
function breakdownGroup(
  item: Record<string, unknown>,
  data: Record<string, unknown>,
): UsageOfficialGroup | "invalid" | undefined {
  if (item.bonuses !== undefined && !Array.isArray(item.bonuses)) return "invalid";
  const resourceType = typeof item.resourceType === "string" ? item.resourceType.trim() : "";
  if (!resourceType || resourceType.length > 80) return "invalid";
  const amounts = creditAmounts(item, data);
  if (amounts === "invalid") return "invalid";
  const mixed = hasInseparableCredits(item);
  const buckets: UsageOfficialBucket[] = [];
  if (amounts && !mixed) {
    buckets.push({
      name: resourceType,
      window: "credit",
      usedPercent: Math.round((amounts.used / amounts.limit) * 10_000) / 100,
      status: amounts.used >= amounts.limit ? "limit_reached" : "ok",
      windowDurationMinutes: amounts.windowDurationMinutes,
      resetsAt: amounts.resetsAt,
    });
  } else if (amounts && mixed) {
    buckets.push({
      name: resourceType,
      description:
        amounts.overage > 0
          ? `${amounts.total} / ${amounts.limit} + ${amounts.overage}`
          : `${amounts.total} / ${amounts.limit}`,
    });
  }
  if (Array.isArray(item.bonuses)) {
    for (const bonus of item.bonuses) {
      if (!record(bonus)) return "invalid";
      buckets.push({ window: "bonus", status: "parse_unavailable" });
    }
  }
  const trial = record(item.freeTrialInfo);
  const trialStatus =
    typeof trial?.freeTrialStatus === "string" ? trial.freeTrialStatus.trim() : "";
  if (trialStatus)
    buckets.push({ window: "freeTrial", name: "freeTrial", description: trialStatus });
  if (buckets.length === 0) return undefined;
  const name = buckets.length > 1 ? resourceType : undefined;
  return { ...(name ? { name } : {}), buckets };
}

function hasInseparableCredits(item: Record<string, unknown>): boolean {
  return (
    (Array.isArray(item.bonuses) && item.bonuses.length > 0) ||
    record(item.freeTrialInfo)?.freeTrialStatus === "ACTIVE"
  );
}

function creditAmounts(
  item: Record<string, unknown>,
  data: Record<string, unknown>,
):
  | {
      total: number;
      used: number;
      limit: number;
      overage: number;
      windowDurationMinutes: number;
      resetsAt: string;
    }
  | "invalid"
  | undefined {
  const total = item.currentUsageWithPrecision;
  const limit = item.usageLimitWithPrecision;
  const overage = item.currentOveragesWithPrecision ?? 0;
  const reset = item.nextDateReset ?? data.nextDateReset;
  if (total === undefined && limit === undefined && item.currentOveragesWithPrecision === undefined)
    return undefined;
  if (
    !nonnegative(total) ||
    !nonnegative(limit) ||
    limit === 0 ||
    !nonnegative(overage) ||
    total < overage
  )
    return "invalid";
  const used = total - overage;
  if (
    used > limit ||
    typeof reset !== "number" ||
    !Number.isFinite(reset) ||
    reset < 1_000_000_000 ||
    reset > 4_102_444_800
  )
    return "invalid";
  const date = new Date(reset * 1000);
  const monthStart = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - 1, 1);
  const monthEnd = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
  return {
    total,
    used,
    limit,
    overage,
    windowDurationMinutes: (monthEnd - monthStart) / 60_000,
    resetsAt: date.toISOString(),
  };
}

/** The old two-slot reading: one CREDIT breakdown whose numbers are not mixed with bonuses
 * or an ACTIVE free trial. Other breakdowns stay on `officialGroups` and are not folded in. */
function cleanCreditPlan(
  data: Record<string, unknown>,
): Pick<UsageSnapshot, "creditUsage" | "primary"> {
  const credits = (data.usageBreakdownList as unknown[])
    .map(record)
    .filter((item) => item?.resourceType === "CREDIT" && !hasInseparableCredits(item));
  if (credits.length !== 1) return {};
  const amounts = creditAmounts(credits[0]!, data);
  if (!amounts || amounts === "invalid") return {};
  return {
    creditUsage: { used: amounts.used, limit: amounts.limit, overage: amounts.overage },
    primary: {
      usedPercent: Math.round((amounts.used / amounts.limit) * 10_000) / 100,
      windowDurationMinutes: amounts.windowDurationMinutes,
      resetsAt: amounts.resetsAt,
    },
  };
}

function nonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
