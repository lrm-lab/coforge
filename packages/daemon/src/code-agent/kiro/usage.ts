import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join, isAbsolute } from "node:path";
import type {
  UsageOfficialBucket,
  UsageOfficialGroup,
  UsageSnapshot,
} from "#src/code-agent/contract";
import { UsageUnavailableError } from "#src/code-agent/contract";
import { record } from "./connection";
import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";

// Kiro's private CLI store/API, also consumed by CodexBar. Never refresh or
// migrate this store. Unknown identities and schemas fail closed.
export async function readKiroUsage(
  options: {
    environment?: Readonly<Record<string, string | undefined>>;
    platform?: NodeJS.Platform;
    timeoutMs?: number;
    fetch?: (url: string, init: RequestInit) => Promise<Response>;
  } = {},
): Promise<UsageSnapshot | null> {
  const environment = options.environment ?? Bun.env;
  const home = environment.HOME ?? homedir();
  const expand = (value: string | undefined) => {
    const path = value?.trim();
    return path?.startsWith("~/") ? join(home, path.slice(2)) : path;
  };
  const root =
    expand(environment.KIRO_DATA_DIR) ||
    ((options.platform ?? process.platform) === "darwin"
      ? join(home, "Library/Application Support/kiro-cli")
      : join(expand(environment.XDG_DATA_HOME) || join(home, ".local/share"), "kiro-cli"));
  if (!isAbsolute(root)) return null;
  const path = join(root, "data.sqlite3");
  if (!(await Bun.file(path).exists())) return null;
  let db: Database | undefined;
  let token: Record<string, unknown> | undefined;
  let profile: Record<string, unknown> | undefined;
  try {
    db = new Database(path, { readonly: true });
    db.exec("PRAGMA busy_timeout = 250; BEGIN");
    const authRow = db
      .query<{ value: string }, []>("SELECT value FROM auth_kv WHERE key = 'kirocli:odic:token'")
      .get();
    const profileRow = db
      .query<{ value: string }, []>(
        "SELECT value FROM state WHERE key = 'api.codewhisperer.profile'",
      )
      .get();
    token = record(JSON.parse(authRow?.value ?? "null"));
    profile = record(JSON.parse(profileRow?.value ?? "null"));
    db.exec("COMMIT");
  } catch {
    return null;
  } finally {
    db?.close();
  }
  if (typeof token?.access_token !== "string" || !token.access_token.trim()) return null;
  if (
    token.expires_at !== undefined &&
    (typeof token.expires_at !== "string" ||
      !Number.isFinite(Date.parse(token.expires_at)) ||
      Date.parse(token.expires_at) <= Date.now())
  )
    return null;
  const arn = profile?.arn;
  // Reject control characters in native profile data before constructing auth headers.
  // oxlint-disable-next-line no-control-regex
  if (typeof arn !== "string" || /\s|[\u0000-\u001f\u007f]/u.test(arn)) return null;
  const match = /^arn:aws:codewhisperer:(us-east-1|eu-central-1):[0-9]{12}:profile\/.+$/.exec(arn);
  if (!match) return null;
  const endpoint =
    match[1] === "us-east-1"
      ? "https://codewhisperer.us-east-1.amazonaws.com/"
      : "https://q.eu-central-1.amazonaws.com/";
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(endpoint, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
      headers: {
        Authorization: `Bearer ${token.access_token}`,
        "Content-Type": "application/x-amz-json-1.0",
        "X-Amz-Target": "AmazonCodeWhispererService.GetUsageLimits",
      },
      body: JSON.stringify({ profileArn: arn }),
    });
    if (response.status === 401 || response.status === 403) return null;
    if (!response.ok) throw new Error("Kiro usage unavailable");
    const result = snapshot(await response.json());
    if (!result) throw new UsageUnavailableError();
    return result;
  } catch (error) {
    if (error instanceof UsageUnavailableError) throw error;
    // Transport errors may include request headers or local paths.
    throw new Error("Kiro usage request failed");
  }
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
