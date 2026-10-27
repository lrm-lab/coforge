import type { UsageOfficialBucket, UsageSnapshot } from "#src/contract";
import { UsageUnavailableError } from "#src/contract";
import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";

/** Kiro's usage read runs two CLI calls (`whoami`, then `chat /usage`) that on the supported
 * machines together take 11 seconds to well over 20, past the scan's shared default. The runtime
 * declares this longer budget, still inside the browser's 60-second wait. */
export const KIRO_USAGE_TIMEOUT_MS = 40_000;

/** The host returns the official `/usage` text, or undefined when the CLI cannot read it. */
export type KiroUsageReader = (
  options: Readonly<{
    workingDirectory: string;
    timeoutMs?: number;
  }>,
) => Promise<string | undefined>;

export async function readKiroUsage(
  options: Readonly<{ workingDirectory: string; timeoutMs?: number }>,
  readResponse: KiroUsageReader,
): Promise<UsageSnapshot> {
  // Kiro reads usage with two CLI calls that together outrun a usage scan's shared default, so this
  // runtime never reads on a shorter budget than its own.
  const response = await readResponse({
    ...options,
    timeoutMs: Math.max(options.timeoutMs ?? 0, KIRO_USAGE_TIMEOUT_MS),
  });
  if (typeof response !== "string") throw new UsageUnavailableError();
  return parseKiroUsageText(response);
}

/**
 * The plan is the first two lines: the reset header, then the credits. The CLI may add notes under
 * them, such as "Overages: Disabled" (2.34.2 on Linux) or the managed-plan sentence. This parser
 * reads none of them; `overage` stays 0, and a plan used past its limit is refused below.
 */
export function parseKiroUsageText(output: string): UsageSnapshot {
  const [headerLine, creditsLine] = Bun.stripANSI(output)
    .split(/\r?\n/gu)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!headerLine || !creditsLine) throw new UsageUnavailableError();
  const header = /^Estimated Usage \| resets on (\d{4}-\d{2}-\d{2}) \| ([^|\r\n]{1,80})$/u.exec(
    headerLine,
  );
  const credits =
    /^Credits \(([\d,]+(?:\.\d+)?) of ([\d,]+(?:\.\d+)?) covered in plan\), (\d+(?:\.\d+)?)%$/u.exec(
      creditsLine,
    );
  if (!header || !credits) throw new UsageUnavailableError();
  const resetsAt = resetDate(header[1]!);
  const used = number(credits[1]!);
  const limit = number(credits[2]!);
  const percent = number(credits[3]!);
  if (
    !Number.isFinite(used) ||
    !Number.isFinite(limit) ||
    !Number.isFinite(percent) ||
    limit <= 0 ||
    used < 0 ||
    used > limit
  )
    throw new UsageUnavailableError();
  const expected = (used / limit) * 100;
  if (Math.abs(expected - percent) > 0.1) throw new UsageUnavailableError();
  const reset = new Date(resetsAt);
  const monthStart = Date.UTC(reset.getUTCFullYear(), reset.getUTCMonth() - 1, 1);
  const windowDurationMinutes = (Date.parse(resetsAt) - monthStart) / 60_000;
  const bucket: UsageOfficialBucket = {
    name: "Credits",
    window: "credit",
    usedPercent: percent,
    status: used >= limit ? "limit_reached" : "ok",
    windowDurationMinutes,
    resetsAt,
  };
  return {
    provider: RUNTIME_PROVIDER.KIRO,
    planType: header[2]!.trim(),
    creditUsage: { used, limit, overage: 0 },
    primary: { usedPercent: percent, status: bucket.status, windowDurationMinutes, resetsAt },
    officialGroups: [{ buckets: [bucket] }],
  };
}

function number(value: string): number {
  return Number(value.replaceAll(",", ""));
}

function resetDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) throw new UsageUnavailableError();
  const timestamp = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const date = new Date(timestamp);
  if (date.toISOString().slice(0, 10) !== value) throw new UsageUnavailableError();
  return date.toISOString();
}
