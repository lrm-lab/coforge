import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import type { AntigravityAcpRuntimeHost } from "./acp-host";
import {
  UsageUnavailableError,
  UsageUnsupportedError,
  type UsageOfficialBucket,
  type UsageOfficialGroup,
  type UsageSnapshot,
  type UsageWindow,
} from "#src/contract";
import { asRecord } from "#src/json-record";
import { antigravityUsesDefaultState } from "./acp-args";
import { withoutSshSessionVariables } from "./ssh-environment";

/** Retained for callers that display the provider's normal usage-read budget. */
export const ANTIGRAVITY_USAGE_TIMEOUT_MS = 15_000;

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
 * Reads quota through an ACP-provided reader when available. Otherwise it first checks the shared
 * credential store without spawning, then uses headless `agy -p /usage` with browser-launching
 * environment disabled. An absent/invalid login answers unavailable rather than entering OAuth.
 */
export async function readAntigravityUsage(
  workingDirectory: string,
  options: {
    command?: readonly string[];
    environment?: Readonly<Record<string, string | undefined>>;
    timeoutMs?: number;
  } = {},
  host: Pick<
    AntigravityAcpRuntimeHost,
    "catalogCommandRunner" | "readUsageEnvironment" | "readUsageAuthStatus" | "readAcpUsage"
  >,
): Promise<UsageSnapshot> {
  if (host.readAcpUsage) {
    try {
      return await host.readAcpUsage({
        workingDirectory,
        timeoutMs: options.timeoutMs ?? ANTIGRAVITY_USAGE_TIMEOUT_MS,
        command: options.command,
        environment: options.environment,
      });
    } catch (error) {
      if (error instanceof UsageUnavailableError || error instanceof UsageUnsupportedError)
        throw error;
      throw new UsageUnavailableError();
    }
  }
  const effectiveEnvironment = options.environment ?? host.readUsageEnvironment();
  if (!antigravityUsesDefaultState(effectiveEnvironment)) throw new UsageUnavailableError();
  if (!host.readUsageAuthStatus || !(await host.readUsageAuthStatus()))
    throw new UsageUnavailableError();
  try {
    const { output } = await host.catalogCommandRunner(
      [...(options.command ?? ["agy"]), "-p", "/usage", "--output-format", "json"],
      workingDirectory,
      {
        ...withoutSshSessionVariables(effectiveEnvironment),
        CI: "1",
        TERM: "dumb",
        BROWSER: "false",
        AGY_NO_BROWSER: "1",
        AGY_CLI_DISABLE_AUTO_UPDATE: "true",
      },
      options.timeoutMs ?? ANTIGRAVITY_USAGE_TIMEOUT_MS,
    );
    return parseAntigravityUsage(output);
  } catch (error) {
    if (error instanceof UsageUnsupportedError) throw error;
    throw new UsageUnavailableError();
  }
}

/** Parses the official `/usage` JSON returned by an ACP-aware test or host adapter. */
export function parseAntigravityUsage(output: string): UsageSnapshot {
  const start = output.startsWith("{") ? 0 : output.indexOf("\n{") + 1;
  const answer = asRecord(parseJson(output.slice(start)));
  if (!answer) throw new Error("Antigravity ACP returned no JSON usage answer");
  if (answer.status !== "SUCCESS") throw new UsageUnavailableError();
  const command = asRecord(answer.command);
  if (command?.name !== undefined && command.name !== "usage") throw new UsageUnavailableError();
  const data = asRecord(command?.data);
  const groups = quotaGroups(data?.groups);
  const credits = parseCredits(data);
  const officialDescription = text(data?.description);
  const group = groups.reduce<QuotaGroup | undefined>(
    (tightest, candidate) =>
      !tightest || leastRemaining(candidate) < leastRemaining(tightest) ? candidate : tightest,
    undefined,
  );
  const primary = group && usageWindow(group, "5h");
  const secondary = group && usageWindow(group, "weekly");
  const officialGroups = groups.map(officialGroup);
  if (officialGroups.length === 0 && !credits) throw new UsageUnsupportedError();
  const exhausted =
    groups.length > 0
      ? groups.some((item) => item.buckets.some((bucket) => bucket.remaining <= 0))
      : Boolean(credits && !credits.hasCredits && !credits.unlimited);
  return {
    provider: RUNTIME_PROVIDER.ANTIGRAVITY,
    ...(officialDescription ? { officialDescription } : {}),
    ...(officialGroups.length > 0 ? { officialGroups } : {}),
    ...(primary ? { primary } : {}),
    ...(secondary ? { secondary } : {}),
    ...(credits ? { credits } : {}),
    health: exhausted ? "rate_limited" : "ok",
  };
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function balanceText(value: unknown): string | undefined {
  const numeric = nonNegativeNumber(value);
  if (numeric !== undefined) return String(numeric);
  const raw = text(value);
  return raw && raw.length <= 40 ? raw : undefined;
}

function parseCredits(
  data: Record<string, unknown> | undefined,
): UsageSnapshot["credits"] | undefined {
  if (!data) return undefined;
  const raw = data.ai_credits ?? data.credits ?? data.available_credits;
  if (raw === undefined || raw === null) return undefined;
  const bareAmount = nonNegativeNumber(raw);
  if (bareAmount !== undefined) {
    return {
      hasCredits: bareAmount > 0,
      unlimited: false,
      balance: String(bareAmount),
    };
  }
  const record = asRecord(raw);
  if (!record) return undefined;
  const unlimited = record.unlimited === true;
  const numericAmount =
    nonNegativeNumber(record.available) ??
    nonNegativeNumber(record.available_credits) ??
    nonNegativeNumber(record.remaining) ??
    nonNegativeNumber(record.remaining_credits) ??
    nonNegativeNumber(record.balance);
  const balance =
    numericAmount !== undefined
      ? String(numericAmount)
      : (balanceText(record.balance) ??
        balanceText(record.available) ??
        balanceText(record.remaining));
  const explicitHas =
    typeof record.hasCredits === "boolean"
      ? record.hasCredits
      : typeof record.has_credits === "boolean"
        ? record.has_credits
        : undefined;
  if (!unlimited && explicitHas === undefined && balance === undefined) return undefined;
  const parsedBalance = balance !== undefined ? Number(balance) : undefined;
  const hasCredits =
    explicitHas ??
    (unlimited ||
      (numericAmount !== undefined
        ? numericAmount > 0
        : parsedBalance !== undefined && Number.isFinite(parsedBalance)
          ? parsedBalance > 0
          : balance !== undefined));
  return {
    hasCredits,
    unlimited,
    ...(balance !== undefined ? { balance } : {}),
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
        !Number.isFinite(remaining) ||
        remaining < 0 ||
        remaining > 1
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

function usedPercentFromRemaining(remaining: number): number {
  if (remaining <= 0) return 100;
  const rounded = Math.round((1 - remaining) * 10_000) / 100;
  return Math.min(99.99, Math.max(0, rounded));
}

function officialBucket(bucket: QuotaBucket): UsageOfficialBucket {
  const minutes = WINDOW_MINUTES[bucket.window];
  return {
    id: bucket.id,
    ...(bucket.name ? { name: bucket.name } : {}),
    ...(bucket.description ? { description: bucket.description } : {}),
    window: bucket.window,
    remainingFraction: bucket.remaining,
    usedPercent: usedPercentFromRemaining(bucket.remaining),
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
  return {
    id: `antigravity-${bucket.id}`,
    usedPercent: usedPercentFromRemaining(bucket.remaining),
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
