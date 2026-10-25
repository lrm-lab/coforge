import {
  MASK_MARKER,
  MAX_LABEL,
  MAX_METHOD_LABEL,
  type RuntimeAuthAccount,
} from "@lrm/coforge-sdk/internal";
import {
  isRuntimeAuthProvider,
  type RuntimeAuthProvider,
  type RuntimeAuthStatus,
} from "./contract";

const STATES: readonly RuntimeAuthStatus["state"][] = [
  "logged_in",
  "logged_out",
  "unknown",
  "unavailable",
];
const UNAVAILABLE_REASONS: readonly NonNullable<RuntimeAuthStatus["unavailableReason"]>[] = [
  "not_installed",
  "version_unsupported",
  "unsupported_installation",
];
/**
 * A runtime's login status as it may leave the Computer and be stored: the daemon applies it
 * before reporting and the server again on receipt. The account follows the login report's limits:
 * its label short and visibly masked (so an unmasked address never passes for a masked one), a plan
 * and a method short, none of them holding control characters; a field that fails is dropped, and
 * an account left empty is absent. Only a logged-in status carries an account, and only an
 * unavailable one a reason.
 * Anything else that does not fit reads as `unknown` for its provider (`provider` when the value
 * names none it can be trusted for); a provider without a login flow is nothing.
 */
export function sanitizeRuntimeAuthStatus(
  value: unknown,
  provider?: RuntimeAuthProvider,
): RuntimeAuthStatus | undefined {
  const record =
    typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const named = record.provider;
  const owner = isRuntimeAuthProvider(named) ? named : named === undefined ? provider : undefined;
  if (!owner) return undefined;
  const unknown: RuntimeAuthStatus = { provider: owner, state: "unknown" };
  const state = record.state;
  if (!STATES.includes(state as RuntimeAuthStatus["state"])) return unknown;
  if (state === "unavailable") {
    const reason = record.unavailableReason;
    return UNAVAILABLE_REASONS.includes(reason as never)
      ? {
          provider: owner,
          state,
          unavailableReason: reason as RuntimeAuthStatus["unavailableReason"],
        }
      : unknown;
  }
  if (state !== "logged_in") return { provider: owner, state: state as RuntimeAuthStatus["state"] };
  const account =
    typeof record.account === "object" && record.account !== null ? record.account : {};
  return { provider: owner, state, ...runtimeAuthAccount(account) };
}

/**
 * An account as a logged-in status spreads it: `{ account }` with the labels that pass the
 * limits above, or nothing when none does. Adapters build their account with it too.
 */
export function runtimeAuthAccount(record: {
  maskedLabel?: unknown;
  planLabel?: unknown;
  methodLabel?: unknown;
}): { account?: RuntimeAuthAccount } {
  const maskedLabel = text(record.maskedLabel, MAX_LABEL);
  const planLabel = text(record.planLabel, MAX_LABEL);
  const methodLabel = text(record.methodLabel, MAX_METHOD_LABEL);
  const account = {
    ...(maskedLabel && MASK_MARKER.test(maskedLabel) ? { maskedLabel } : {}),
    ...(planLabel ? { planLabel } : {}),
    ...(methodLabel ? { methodLabel } : {}),
  };
  return Object.keys(account).length > 0 ? { account } : {};
}

/** A short, printable, non-blank string, trimmed; anything else is nothing. */
function text(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed && [...trimmed].length <= max && !/[\p{Cc}\p{Cf}]/u.test(trimmed)
    ? trimmed
    : undefined;
}
