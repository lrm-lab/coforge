import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import { runCatalogCommand } from "#src/code-agent/catalog-command";
import {
  UsageUnavailableError,
  UsageUnsupportedError,
  type UsageOfficialBucket,
  type UsageOfficialGroup,
  type UsageSnapshot,
  type UsageWindow,
} from "#src/code-agent/contract";
import { asRecord } from "#src/code-agent/json-record";
import { withoutSshSessionVariables } from "./ssh-environment";

/** How long `agy -p /usage` may run when the caller sets no deadline. It answers from the
 * account's quota without starting a turn or spending quota (agy 1.1.11 changelog), but still
 * fetches over the network. */
export const ANTIGRAVITY_USAGE_TIMEOUT_MS = 15_000;

const SIGNED_OUT = /sign(?:ed)?[ -]?in|log(?:ged)?[ -]?in|auth/iu;

const WINDOW_MINUTES: Readonly<Record<string, number>> = { "5h": 300, weekly: 10_080 };

type QuotaBucket = {
  id: string;
  name?: string;
  description?: string;
  window: string;
  remaining: number;
  resetsAt?: string;
};
type QuotaGroup = { name: string; description?: string; buckets: QuotaBucket[] };

/**
 * Reads the account's quota with `agy -p /usage --output-format json`. Every returned group and
 * bucket is kept on `officialGroups`, including a group that has only a weekly bucket. The
 * provider's own `command.data.description` is kept as `officialDescription`. `primary` and
 * `secondary` stay the tightest group's 5-hour and weekly windows so an older Web still has its
 * two slots. A group name is not a plan, so `planType` stays unset. The response has no pacing
 * field, so none is derived.
 */
export async function readAntigravityUsage(
  workingDirectory: string,
  options: {
    command?: readonly string[];
    environment?: Readonly<Record<string, string | undefined>>;
    timeoutMs?: number;
  } = {},
): Promise<UsageSnapshot> {
  const { output, exitCode } = await runCatalogCommand(
    [...(options.command ?? ["agy"]), "-p", "/usage", "--output-format", "json"],
    workingDirectory,
    withoutSshSessionVariables(options.environment ?? Bun.env),
    options.timeoutMs ?? ANTIGRAVITY_USAGE_TIMEOUT_MS,
  );
  // A local wrapper may print a banner before the JSON answer; the answer starts at the first
  // line that opens an object and runs to the end.
  const start = output.startsWith("{") ? 0 : output.indexOf("\n{") + 1;
  const answer = asRecord(parseJson(output.slice(start)));
  if (!answer) {
    if (SIGNED_OUT.test(output)) throw new UsageUnavailableError();
    throw new Error(`agy /usage exited ${exitCode} without a JSON answer`);
  }
  if (answer.status !== "SUCCESS") {
    const error = typeof answer.error === "string" ? answer.error : "";
    if (SIGNED_OUT.test(error)) throw new UsageUnavailableError();
    throw new Error(`agy /usage failed: ${error || String(answer.status)}`);
  }
  const data = asRecord(asRecord(answer.command)?.data);
  const groups = quotaGroups(data?.groups);
  const officialDescription = text(data?.description);
  const group = groups.reduce<QuotaGroup | undefined>(
    (tightest, candidate) =>
      !tightest || leastRemaining(candidate) < leastRemaining(tightest) ? candidate : tightest,
    undefined,
  );
  const primary = group && usageWindow(group, "5h");
  const secondary = group && usageWindow(group, "weekly");
  const officialGroups = groups.map(officialGroup);
  if (officialGroups.length === 0 || officialGroups.every((item) => item.buckets.length === 0)) {
    throw new UsageUnsupportedError();
  }
  const exhausted = groups.some((item) => item.buckets.some((bucket) => bucket.remaining <= 0));
  return {
    provider: RUNTIME_PROVIDER.ANTIGRAVITY,
    ...(officialDescription ? { officialDescription } : {}),
    officialGroups,
    ...(primary ? { primary } : {}),
    ...(secondary ? { secondary } : {}),
    health: exhausted ? "rate_limited" : "ok",
  };
}

function quotaGroups(value: unknown): QuotaGroup[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    const group = asRecord(raw);
    if (typeof group?.name !== "string" || !Array.isArray(group.buckets)) return [];
    const buckets = group.buckets.flatMap((rawBucket): QuotaBucket[] => {
      const bucket = asRecord(rawBucket);
      const remaining = bucket?.remaining_fraction;
      if (
        typeof bucket?.id !== "string" ||
        typeof bucket.window !== "string" ||
        typeof remaining !== "number" ||
        !Number.isFinite(remaining)
      )
        return [];
      const resetsAt = instant(bucket.reset_time);
      const name = text(bucket.name);
      const description = text(bucket.description);
      return [
        {
          id: bucket.id,
          window: bucket.window,
          remaining,
          ...(name ? { name } : {}),
          ...(description ? { description } : {}),
          ...(resetsAt ? { resetsAt } : {}),
        },
      ];
    });
    const description = text(group.description);
    return buckets.length
      ? [{ name: group.name, ...(description ? { description } : {}), buckets }]
      : [];
  });
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function officialGroup(group: QuotaGroup): UsageOfficialGroup {
  return {
    name: group.name,
    ...(group.description ? { description: group.description } : {}),
    buckets: group.buckets.map(officialBucket),
  };
}

function officialBucket(bucket: QuotaBucket): UsageOfficialBucket {
  const minutes = WINDOW_MINUTES[bucket.window];
  const used = Math.min(1, Math.max(0, 1 - bucket.remaining));
  return {
    id: bucket.id,
    ...(bucket.name ? { name: bucket.name } : {}),
    ...(bucket.description ? { description: bucket.description } : {}),
    window: bucket.window,
    remainingFraction: bucket.remaining,
    usedPercent: Math.round(used * 10_000) / 100,
    status: bucket.remaining <= 0 ? "limit_reached" : "ok",
    ...(minutes !== undefined ? { windowDurationMinutes: minutes } : {}),
    ...(bucket.resetsAt ? { resetsAt: bucket.resetsAt } : {}),
  };
}

function leastRemaining(group: QuotaGroup): number {
  return Math.min(...group.buckets.map((bucket) => bucket.remaining));
}

function usageWindow(group: QuotaGroup, window: string): UsageWindow | undefined {
  const bucket = group.buckets.find((candidate) => candidate.window === window);
  const minutes = WINDOW_MINUTES[window];
  if (!bucket || minutes === undefined) return undefined;
  const used = Math.min(1, Math.max(0, 1 - bucket.remaining));
  return {
    id: `antigravity-${bucket.id}`,
    usedPercent: Math.round(used * 10_000) / 100,
    status: bucket.remaining <= 0 ? "limit_reached" : "ok",
    windowDurationMinutes: minutes,
    ...(bucket.resetsAt ? { resetsAt: bucket.resetsAt } : {}),
  };
}

function instant(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function parseJson(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}
