import {
  UsageUnavailableError,
  UsageUnsupportedError,
  type UsageSnapshot,
} from "#src/code-agent/contract";
import { type UsageScanResponse, utf8Encoder } from "@lrm/coforge-sdk/internal";

/** A usage scan answer: accepted exactly when it carries a snapshot. */
export function usageScanResult(
  status: UsageScanResponse["status"],
  snapshot?: UsageSnapshot,
  message?: string,
): UsageScanResponse {
  return {
    protocolMajor: 1,
    requestId: "",
    accepted: Boolean(snapshot),
    status,
    ...(snapshot ? { snapshotJson: utf8Encoder.encode(JSON.stringify(snapshot)) } : {}),
    ...(message ? { message } : {}),
  };
}

/**
 * The one place a scan result gets its `collectedAt`: a fresh reading is stamped `now`; an
 * observed snapshot reused from the session's own usage events already carries the time it was
 * observed, which this must not overwrite.
 */
export function stampedUsage(snapshot: UsageSnapshot, now: () => Date): UsageSnapshot {
  return snapshot.collectedAt ? snapshot : { ...snapshot, collectedAt: now().toISOString() };
}

/** The answer to a scan that did not throw: the provider's reading, or the observed snapshot the
 * caller fell back to, or `reauth` when there is neither. */
export function usageScanReading(
  snapshot: UsageSnapshot | undefined,
  now: () => Date,
): UsageScanResponse {
  return snapshot
    ? usageScanResult("available", stampedUsage(snapshot, now))
    : usageScanResult("reauth", undefined, "Provider usage is unavailable");
}

/**
 * The answer to a reading that threw. A non-subscription account has no plan usage at all, so
 * `unsupported` wins over a stale observed snapshot, which a reading like this can never have
 * produced; any other failure falls back to the observed snapshot when there is one. `observed` is
 * only asked for in that case, because reading it also prunes expired windows.
 */
export function usageScanFailure(
  error: unknown,
  observed: () => UsageSnapshot | undefined,
  now: () => Date,
): UsageScanResponse {
  if (error instanceof UsageUnsupportedError)
    return usageScanResult(
      "unsupported",
      undefined,
      "Usage scanning is unsupported for this account",
    );
  const snapshot = observed();
  if (snapshot) return usageScanResult("available", stampedUsage(snapshot, now));
  return error instanceof UsageUnavailableError
    ? usageScanResult("unavailable", undefined, "Provider usage is unavailable")
    : usageScanResult("error", undefined, "Usage scan failed");
}
