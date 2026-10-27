import type { RuntimeAuthStatus } from "@lrm/coforge-anvil";
import { m } from "#src/paraglide/messages";
import type { UsageReadResult, UsageResultRecord } from "#src/server/centrifugo/usage-cache.server";

/** `ok` only when the last read is fresh, available, and no usage window is at its limit; `label`
 * is the popover badge's own word for it, so the dot and the badge never name it differently. */
export type UsageHealth = { ok: boolean; label: string };

/**
 * Whether a runtime is signed in is its own login check (`auth`), never the usage reader. A reader
 * asking to sign in again while that check says signed in holds a stale or unreadable credential
 * of its own, so its read counts as usage unavailable: the popover names the login state once.
 */
export function usageReadForAuth(
  data: UsageReadResult | undefined,
  auth: RuntimeAuthStatus | undefined,
): UsageReadResult | undefined {
  if (auth?.state !== "logged_in" || data?.result?.status !== "reauth") return data;
  return { ...data, result: { ...data.result, status: "unavailable" } };
}

export function usageHealth(data: UsageReadResult | undefined): UsageHealth | undefined {
  if (!data?.result) return undefined;
  const badge = usageBadge(data.result);
  if (!badge) return undefined;
  if (badge.color !== "success") return { ok: false, label: badge.label };
  return data.state === "fresh"
    ? { ok: true, label: m.computer_usage_health_ok() }
    : { ok: false, label: m.computer_usage_health_attention() };
}

const USAGE_READER_NOT_CONNECTED = "Usage reader is not connected yet";

export function usageBadge(
  result: UsageResultRecord,
): { color: "success" | "warning" | "error"; label: string } | undefined {
  if (result.status === "reauth")
    return { color: "warning", label: m.computer_runtime_auth_logged_out() };
  if (result.status === "unavailable")
    return { color: "warning", label: m.computer_usage_read_error() };
  if (result.status === "error") return { color: "error", label: m.computer_usage_read_error() };
  if (result.status === "unsupported")
    return {
      color: "warning",
      label:
        result.message === USAGE_READER_NOT_CONNECTED
          ? m.computer_usage_not_connected()
          : m.computer_usage_badge_unsupported(),
    };
  const rateLimited =
    result.snapshot?.health === "rate_limited" ||
    result.snapshot?.primary?.status === "limit_reached" ||
    result.snapshot?.secondary?.status === "limit_reached" ||
    result.snapshot?.officialGroups?.some((group) =>
      group.buckets.some((bucket) => bucket.status === "limit_reached"),
    ) === true;
  return rateLimited
    ? { color: "warning", label: m.computer_usage_limit_reached() }
    : { color: "success", label: m.computer_usage_badge_ok() };
}

export function usageFailureDescription(result: UsageResultRecord | undefined) {
  const status = result?.status;
  if (status === "reauth") return m.computer_usage_reauth();
  if (status === "unavailable") return m.computer_usage_unavailable_now();
  if (status === "error") return m.computer_usage_read_failed_retry();
  if (status === "unsupported")
    return result?.message === USAGE_READER_NOT_CONNECTED
      ? m.computer_usage_not_connected()
      : m.computer_usage_status_unsupported();
  return undefined;
}
