import {
  UsageUnavailableError,
  type UsageOfficialBucket,
  type UsageSnapshot,
  type UsageWindow,
} from "#src/code-agent/contract";
import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import { maskEmail } from "#src/code-agent/mask-email";
import { claudeCliEnvironment, runClaudeCli as run } from "./process";

export async function readClaudeCodeUsage(
  workingDirectory: string,
  options: {
    command?: readonly string[];
    environment?: Readonly<Record<string, string>>;
    timeoutMs?: number;
  } = {},
): Promise<UsageSnapshot | null> {
  const baseCommand = options.command ?? ["claude"];
  const timeoutMs = options.timeoutMs ?? 5_000;
  const environment = claudeCliEnvironment(options.environment);
  const auth = await run(
    [...baseCommand, "auth", "status", "--json"],
    workingDirectory,
    environment,
    timeoutMs,
  );
  if (auth.timedOut) throw new ClaudeUsageTimeoutError();
  if (auth.exitCode !== 0 || !loggedIn(auth.stdout)) return null;
  const usage = await run(
    [...baseCommand, "-p", "/usage", "--output-format", "json"],
    workingDirectory,
    environment,
    timeoutMs,
  );
  if (usage.timedOut) throw new ClaudeUsageTimeoutError();
  // Authentication succeeded above; a failed quota read must not request another sign-in.
  if (usage.exitCode !== 0) throw new UsageUnavailableError();
  const snapshot = parseUsage(usage.stdout);
  if (!snapshot) throw new UsageUnavailableError();
  return { ...snapshot, ...account(auth.stdout) };
}

export class ClaudeUsageTimeoutError extends Error {
  constructor() {
    super("Claude Code usage request timed out");
  }
}

function loggedIn(output: string): boolean {
  try {
    const value = JSON.parse(output) as Record<string, unknown>;
    return value.loggedIn === true || value.isLoggedIn === true || value.authenticated === true;
  } catch {
    return false;
  }
}

/** The plan and the signed-in address the sign-in report already carries. The address is masked
 * here so the full one never leaves this Computer. */
function account(output: string): Pick<UsageSnapshot, "planType" | "accountLabel"> {
  try {
    const value = JSON.parse(output) as Record<string, unknown>;
    const accountLabel = typeof value.email === "string" ? maskEmail(value.email) : undefined;
    return {
      ...(typeof value.subscriptionType === "string" && value.subscriptionType
        ? { planType: value.subscriptionType }
        : {}),
      ...(accountLabel ? { accountLabel } : {}),
    };
  } catch {
    return {};
  }
}

function parseUsage(output: string): UsageSnapshot | null {
  let text = output;
  try {
    const value = JSON.parse(output) as unknown;
    if (typeof value === "string") text = value;
    else if (value && typeof value === "object") {
      if ("result" in value && typeof value.result === "string") text = value.result;
      else if ("text" in value && typeof value.text === "string") text = value.text;
      else return null;
    } else return null;
  } catch {
    /* Some Claude versions emit the report as plain text. */
  }
  const primary = window(
    text,
    /^Current session:?\s+([\d.]+)%[^\r\n]{0,100}?(?:reset|resets)[^\r\n]{0,40}?(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})(?:,\s+(\d{4}),|\s+at)\s+(\d{1,2}):(\d{2})\s*(am|pm)\s*\(UTC\)/im,
  );
  const secondary = window(
    text,
    /^Current week(?: \(all models\))?:?\s+([\d.]+)%[^\r\n]{0,100}?(?:reset|resets)[^\r\n]{0,40}?(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})(?:,\s+(\d{4}),|\s+at)\s+(\d{1,2}):(\d{2})\s*(am|pm)\s*\(UTC\)/im,
  );
  // Every printed line stays, including a model-specific week beside "all models". The two
  // slots above stay the session and the all-models week so an older Web still has them.
  const buckets = usageLines(text);
  if (!primary && !secondary && buckets.length === 0) return null;
  return {
    provider: RUNTIME_PROVIDER.CLAUDE_CODE,
    ...(primary ? { primary } : {}),
    ...(secondary ? { secondary } : {}),
    ...(buckets.length > 0 ? { officialGroups: [{ buckets }] } : {}),
  };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** One `/usage` line. The percent is used, not remaining, so the bucket does not set
 * `remainingFraction`. A line whose reset cannot be read is still kept. */
function usageLines(text: string): UsageOfficialBucket[] {
  const buckets: UsageOfficialBucket[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    const match = /^(.*?)\s+(\d+(?:\.\d+)?)%\s+used\b/i.exec(line);
    if (!match) continue;
    const name = match[1]?.replace(/:\s*$/, "").trim();
    const usedPercent = Number(match[2]);
    if (
      !name ||
      name.length > 200 ||
      !Number.isFinite(usedPercent) ||
      usedPercent < 0 ||
      usedPercent > 100
    )
      continue;
    const resetsAt = resetInstant(line);
    const minutes = resetsAt
      ? Math.max(0, Math.round((Date.parse(resetsAt) - Date.now()) / 60_000))
      : 0;
    buckets.push({
      name,
      usedPercent,
      status: usedPercent >= 100 ? "limit_reached" : "ok",
      ...(minutes > 0 ? { windowDurationMinutes: minutes } : {}),
      ...(resetsAt ? { resetsAt } : {}),
    });
  }
  return buckets;
}

function resetInstant(line: string): string | undefined {
  const match = line.match(
    /(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})(?:,\s+(\d{4}),|\s+at)\s+(\d{1,2}):(\d{2})\s*(am|pm)\s*\(UTC\)/i,
  );
  if (!match) return undefined;
  const month = MONTHS.indexOf(
    (match[1] ?? "").slice(0, 1).toUpperCase() + (match[1] ?? "").slice(1, 3).toLowerCase(),
  );
  let hour = Number(match[4]);
  if ((match[6] ?? "").toLowerCase() === "pm" && hour !== 12) hour += 12;
  if ((match[6] ?? "").toLowerCase() === "am" && hour === 12) hour = 0;
  const now = new Date();
  let year = match[3] ? Number(match[3]) : now.getUTCFullYear();
  if (!match[3]) {
    if (month - now.getUTCMonth() < -6) year += 1;
    if (month - now.getUTCMonth() > 6) year -= 1;
  }
  const reset = new Date(Date.UTC(year, month, Number(match[2]), hour, Number(match[5])));
  if (month < 0 || Number.isNaN(reset.getTime())) return undefined;
  return reset.toISOString();
}

function window(text: string, pattern: RegExp): UsageWindow | undefined {
  const match = text.match(pattern);
  if (!match) return undefined;
  const usedPercent = Number(match[1]);
  const month = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ].indexOf(match[2] ?? "");
  let hour = Number(match[5]);
  if ((match[7] ?? "").toLowerCase() === "pm" && hour !== 12) hour += 12;
  if ((match[7] ?? "").toLowerCase() === "am" && hour === 12) hour = 0;
  const now = new Date();
  let year = match[4] ? Number(match[4]) : now.getUTCFullYear();
  // Session/week resets are near the scan date, including just-expired windows.
  // Infer the adjacent year around New Year without moving stale resets a year ahead.
  if (!match[4]) {
    if (month - now.getUTCMonth() < -6) year += 1;
    if (month - now.getUTCMonth() > 6) year -= 1;
  }
  const reset = new Date(Date.UTC(year, month, Number(match[3]), hour, Number(match[6])));
  if (!Number.isFinite(usedPercent) || month < 0 || Number.isNaN(reset.getTime())) return undefined;
  return {
    usedPercent,
    windowDurationMinutes: Math.max(0, Math.round((reset.getTime() - Date.now()) / 60_000)),
    resetsAt: reset.toISOString(),
  };
}
