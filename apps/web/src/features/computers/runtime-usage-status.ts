import type { RuntimeAuthStatus } from "@lrm/coforge-anvil";
import { m } from "#src/paraglide/messages";
import type { UsageReadResult, UsageResultRecord } from "#src/server/centrifugo/usage-cache.server";

/**
 * One runtime state as the Computer page names it: the chip's dot and the popover's badge both
 * read this one table (task #209). `ok` is green; anything else is orange, a state the user can
 * wait out, retry or sign in to fix. Red is kept for a state retrying cannot fix, and none is.
 * A state that is nobody's problem (a failed usage read, a runtime that reports no usage) has
 * no entry, so no dot.
 */
export type RuntimeStatus = { ok: boolean; label: string };

/** Where a login state needs saying: `unreported` is a Computer too old to report this runtime's. */
export type AccountState = RuntimeAuthStatus["state"] | "unreported";

export function accountStatus(state: AccountState | undefined): RuntimeStatus | undefined {
  if (state === "logged_in") return { ok: true, label: m.computer_runtime_auth_logged_in() };
  if (state === "logged_out") return { ok: false, label: m.computer_runtime_auth_logged_out() };
  if (state === "unreported") return { ok: false, label: m.computer_runtime_auth_upgrade() };
  return undefined;
}

/**
 * The login state as shown (Frank, task #209). A login check that failed while the usage still
 * reads counts as signed in: reading usage needs a signed-in account. Failed with no usage either,
 * it is simply not signed in, with Sign In beside it.
 */
export function shownAccount(
  account: AccountState | undefined,
  usage: UsageReadResult | undefined,
): AccountState | undefined {
  if (account !== "unknown") return account;
  return usage?.result?.status === "available" ? "logged_in" : "logged_out";
}

/** The states only the user can resolve, said in the popover's orange account band. */
export function accountBand(state: AccountState | undefined): RuntimeStatus | undefined {
  return state === "logged_out" || state === "unreported" ? accountStatus(state) : undefined;
}

/** A login state that needs saying: the popover's orange account band, and first on the chip. */
export function accountProblem(state: AccountState | undefined): RuntimeStatus | undefined {
  const status = accountStatus(state);
  return status?.ok ? undefined : status;
}

/** The chip's one dot: a login state that needs saying, then the usage, then a plain sign-in. */
export function chipStatus(
  account: AccountState | undefined,
  usage: RuntimeStatus | undefined,
): RuntimeStatus | undefined {
  return accountProblem(account) ?? usage ?? accountStatus(account);
}

/**
 * Whether a runtime is signed in is its own login check (`account`), never the usage reader. A
 * reader asking to sign in again while that check says anything but signed out holds a stale or
 * unreadable credential of its own, so its read counts as usage unavailable: the popover names
 * the login state once, as the login check has it.
 */
export function usageReadForAuth(
  data: UsageReadResult | undefined,
  account: AccountState | undefined,
): UsageReadResult | undefined {
  if (!account || account === "logged_out" || data?.result?.status !== "reauth") return data;
  return { ...data, result: { ...data.result, status: "unavailable" } };
}

/** The chip's dot for usage: the badge's state, with a plain OK named as usage. A stale read is
 * still OK: the popover's "x minutes ago" already says how old it is. */
export function usageHealth(data: UsageReadResult | undefined): RuntimeStatus | undefined {
  const status = data?.result && usageStatus(data.result);
  if (!status?.ok) return status;
  return { ok: true, label: m.computer_usage_health_ok() };
}

const USAGE_READER_NOT_CONNECTED = "Usage reader is not connected yet";

/** The popover badge. A reader that is not connected, or a runtime that reports no usage, is not
 * the user's to fix: no badge, only the gray line `usageFailureDescription` gives. */
export function usageStatus(result: UsageResultRecord): RuntimeStatus | undefined {
  if (result.status === "reauth") return accountStatus("logged_out");
  // A read that failed says nothing about the runtime: no badge, no dot, no usage (Frank, #209).
  if (
    result.status === "unavailable" ||
    result.status === "error" ||
    result.status === "unsupported"
  )
    return undefined;
  const rateLimited =
    result.snapshot?.health === "rate_limited" ||
    result.snapshot?.primary?.status === "limit_reached" ||
    result.snapshot?.secondary?.status === "limit_reached" ||
    result.snapshot?.officialGroups?.some((group) =>
      group.buckets.some((bucket) => bucket.status === "limit_reached"),
    ) === true;
  return rateLimited
    ? { ok: false, label: m.computer_usage_limit_reached() }
    : { ok: true, label: m.computer_usage_badge_ok() };
}

export function usageFailureDescription(result: UsageResultRecord | undefined) {
  const status = result?.status;
  if (status === "reauth") return m.computer_usage_reauth();
  if (status === "unsupported")
    return result?.message === USAGE_READER_NOT_CONNECTED
      ? m.computer_usage_not_connected()
      : m.computer_usage_status_unsupported();
  return undefined;
}
