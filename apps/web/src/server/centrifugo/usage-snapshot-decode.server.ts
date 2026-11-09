import {
  RESET_CREDITS_MAX,
  isRecord,
  utf8Decoder,
  type RuntimeMetadata,
} from "@lrm/coforge-sdk/internal";
import type { UsageSnapshot } from "./usage-cache.server";

/** A usage snapshot as a Computer reports it: checked field by field, so one malformed field
 * rejects the whole reading instead of reaching the cache. */
export function decodeUsageSnapshot(
  bytes: Uint8Array,
  expectedProvider: RuntimeMetadata["provider"],
): UsageSnapshot | undefined {
  if (bytes.byteLength > 16_384) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(utf8Decoder.decode(bytes));
  } catch {
    return undefined;
  }
  const snapshot = record(value);
  if (!snapshot || snapshot.provider !== expectedProvider) return undefined;
  const planType = snapshot.planType;
  if (planType !== undefined && (typeof planType !== "string" || planType.length > 100))
    return undefined;
  const primary = usageWindow(snapshot.primary);
  const secondary = usageWindow(snapshot.secondary);
  const officialGroups = usageOfficialGroups(snapshot.officialGroups);
  if (snapshot.officialGroups !== undefined && !officialGroups) return undefined;
  const officialDescription = officialText(snapshot.officialDescription, 2_000);
  if (officialDescription === null) return undefined;
  if (
    (snapshot.primary !== undefined && !primary) ||
    (snapshot.secondary !== undefined && !secondary)
  )
    return undefined;
  const credits = record(snapshot.credits);
  const balance = credits ? creditBalance(credits.balance) : undefined;
  const parsedCredits =
    credits && typeof credits.hasCredits === "boolean" && typeof credits.unlimited === "boolean"
      ? {
          hasCredits: credits.hasCredits,
          unlimited: credits.unlimited,
          ...(balance ? { balance } : {}),
        }
      : undefined;
  if (snapshot.credits !== undefined && !parsedCredits) return undefined;
  if (balance === null) return undefined;
  const amounts = record(snapshot.creditUsage);
  const creditUsage =
    amounts &&
    typeof amounts.used === "number" &&
    Number.isFinite(amounts.used) &&
    amounts.used >= 0 &&
    typeof amounts.limit === "number" &&
    Number.isFinite(amounts.limit) &&
    amounts.limit > 0 &&
    amounts.used <= amounts.limit &&
    typeof amounts.overage === "number" &&
    Number.isFinite(amounts.overage) &&
    amounts.overage >= 0
      ? { used: amounts.used, limit: amounts.limit, overage: amounts.overage }
      : undefined;
  if (snapshot.creditUsage !== undefined && (!creditUsage || !primary)) return undefined;
  // Only a plausible count is shown; anything else is left out, and the reading stays.
  const resetCredits = snapshot.resetCreditsAvailable;
  const resetCreditsAvailable =
    typeof resetCredits === "number" &&
    Number.isInteger(resetCredits) &&
    resetCredits >= 0 &&
    resetCredits <= RESET_CREDITS_MAX
      ? resetCredits
      : undefined;
  const collectedAt = snapshot.collectedAt;
  if (
    collectedAt !== undefined &&
    (typeof collectedAt !== "string" || Number.isNaN(Date.parse(collectedAt)))
  )
    return undefined;
  const accountLabel = snapshot.accountLabel;
  if (accountLabel !== undefined && !isValidAccountLabel(accountLabel)) return undefined;
  const health = snapshot.health;
  if (
    health !== undefined &&
    (typeof health !== "string" ||
      (health !== "ok" &&
        health !== "rate_limited" &&
        health !== "reauth_required" &&
        health !== "unsupported" &&
        health !== "error"))
  )
    return undefined;
  return {
    provider: expectedProvider,
    ...(typeof planType === "string" ? { planType } : {}),
    ...(primary ? { primary } : {}),
    ...(secondary ? { secondary } : {}),
    ...(officialGroups ? { officialGroups } : {}),
    ...(officialDescription ? { officialDescription } : {}),
    ...(parsedCredits ? { credits: parsedCredits } : {}),
    ...(creditUsage ? { creditUsage } : {}),
    ...(resetCreditsAvailable !== undefined ? { resetCreditsAvailable } : {}),
    ...(typeof collectedAt === "string" ? { collectedAt } : {}),
    ...(typeof accountLabel === "string" ? { accountLabel } : {}),
    ...(typeof health === "string" ? { health } : {}),
  };
}

/** Codex `credits.balance` when this schema version sends it. `undefined` when absent or null.
 * `null` when present but not a short string, so the snapshot is rejected instead of dropping it. */
function creditBalance(value: unknown): string | undefined | null {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") return null;
  const balance = value.trim();
  if (balance.length === 0 || balance.length > 40) return null;
  return balance;
}

/** A masked account email: at most 80 characters, no control characters, and containing at
 * least one `*` — a raw, unmasked address never passes this check. */
function isValidAccountLabel(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 80 &&
    value.includes("*") &&
    // oxlint-disable-next-line no-control-regex -- Reject control bytes in a masked address.
    !/[\x00-\x1f\x7f]/u.test(value)
  );
}

function usageOfficialGroups(value: unknown): UsageSnapshot["officialGroups"] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 12) return undefined;
  const groups = [];
  for (const raw of value) {
    const group = record(raw);
    if (
      !group ||
      !Array.isArray(group.buckets) ||
      group.buckets.length === 0 ||
      group.buckets.length > 12
    )
      return undefined;
    const name = officialText(group.name, 200);
    const description = officialText(group.description, 2_000);
    if (name === null || description === null) return undefined;
    const buckets = [];
    for (const rawBucket of group.buckets) {
      const bucket = record(rawBucket);
      if (!bucket) return undefined;
      const id = officialText(bucket.id, 100);
      const bucketName = officialText(bucket.name, 200);
      const bucketDescription = officialText(bucket.description, 2_000);
      const windowKey = officialText(bucket.window, 40);
      if (id === null || bucketName === null || bucketDescription === null || windowKey === null) {
        return undefined;
      }
      const remaining = officialUnit(bucket.remainingFraction);
      const usedPercent = officialPercent(bucket.usedPercent);
      const status = officialBucketStatus(bucket.status);
      const minutes = officialMinutes(bucket.windowDurationMinutes);
      const resetsAt = officialInstant(bucket.resetsAt);
      // A present field that cannot be read rejects the snapshot. Dropping it would show a
      // bucket whose official number or reset had been thrown away.
      if (
        remaining === null ||
        usedPercent === null ||
        status === null ||
        minutes === null ||
        resetsAt === null
      )
        return undefined;
      buckets.push({
        ...(id ? { id } : {}),
        ...(bucketName ? { name: bucketName } : {}),
        ...(bucketDescription ? { description: bucketDescription } : {}),
        ...(windowKey ? { window: windowKey } : {}),
        ...(typeof remaining === "number" ? { remainingFraction: remaining } : {}),
        ...(typeof usedPercent === "number" ? { usedPercent } : {}),
        ...(status ? { status } : {}),
        ...(typeof minutes === "number" ? { windowDurationMinutes: minutes } : {}),
        ...(resetsAt ? { resetsAt } : {}),
      });
    }
    groups.push({
      ...(name ? { name } : {}),
      ...(description ? { description } : {}),
      buckets,
    });
  }
  return groups;
}

/** `undefined` when absent. `null` when present but not a finite share from 0 to 1. */
function officialUnit(value: unknown): number | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) return null;
  return value;
}

/** `undefined` when absent. `null` when present but not a finite percent from 0 to 100. */
function officialPercent(value: unknown): number | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) return null;
  return value;
}

/** `undefined` when absent. `null` when present but not a positive finite number of minutes. */
function officialMinutes(value: unknown): number | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return value;
}

/** `undefined` when absent. `null` for an unknown status, including a non-string. */
function officialBucketStatus(
  value: unknown,
): "ok" | "limit_reached" | "parse_unavailable" | undefined | null {
  if (value === undefined) return undefined;
  if (value === "ok" || value === "available") return "ok";
  if (value === "limit_reached" || value === "rate-limited") return "limit_reached";
  if (value === "parse_unavailable") return "parse_unavailable";
  return null;
}

/** `undefined` when absent. `null` when present but not a short parseable instant. */
function officialInstant(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 100 ||
    Number.isNaN(Date.parse(value))
  )
    return null;
  return value;
}

/** `undefined` when the field is absent or blank. `null` when it is present but unusable. */
function officialText(value: unknown, max: number): string | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (text.length > max) return null;
  return text.length > 0 ? text : undefined;
}

function usageWindow(value: unknown): UsageSnapshot["primary"] | undefined {
  const window = record(value);
  if (!window) return undefined;
  if (
    typeof window.windowDurationMinutes !== "number" ||
    !Number.isFinite(window.windowDurationMinutes) ||
    window.windowDurationMinutes <= 0 ||
    (window.resetsAt !== undefined &&
      (typeof window.resetsAt !== "string" ||
        window.resetsAt.length > 100 ||
        Number.isNaN(Date.parse(window.resetsAt)))) ||
    (window.usedPercent !== undefined &&
      (typeof window.usedPercent !== "number" ||
        !Number.isFinite(window.usedPercent) ||
        window.usedPercent < 0 ||
        window.usedPercent > 100)) ||
    (window.status !== undefined &&
      // `available` / `rate-limited` are the older vocabulary an un-upgraded Computer still
      // sends; they normalize to `ok` / `limit_reached` below so those snapshots keep ingesting
      // during the Web-first deploy window.
      window.status !== "ok" &&
      window.status !== "limit_reached" &&
      window.status !== "parse_unavailable" &&
      window.status !== "available" &&
      window.status !== "rate-limited")
  )
    return undefined;
  const status =
    window.status === "ok" ||
    window.status === "limit_reached" ||
    window.status === "parse_unavailable"
      ? window.status
      : window.status === "rate-limited"
        ? "limit_reached"
        : window.status === "available"
          ? "ok"
          : undefined;
  return {
    windowDurationMinutes: window.windowDurationMinutes,
    ...(typeof window.resetsAt === "string" ? { resetsAt: window.resetsAt } : {}),
    ...(typeof window.usedPercent === "number" ? { usedPercent: window.usedPercent } : {}),
    ...(typeof window.id === "string" && window.id.length > 0 && window.id.length <= 100
      ? { id: window.id }
      : {}),
    ...(status ? { status } : {}),
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}
