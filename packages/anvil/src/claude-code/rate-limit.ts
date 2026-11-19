import { type AgentRuntimeEvent, type UsageSnapshot } from "#src/contract";
import { asRecord } from "#src/json-record";
import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";

type FailureEvent = Extract<AgentRuntimeEvent, { type: "error" }>;
type ProviderLimit = NonNullable<FailureEvent["providerLimit"]>;

/** `opening`, then `closing` at most 60 characters later on the same line, with no period in
 * between; case is ignored. */
function phrasePair(opening: string, closing: string): RegExp {
  return new RegExp(`${opening}[^.\\n]{0,60}${closing}`, "i");
}

/** Claude Code's own wording for an exhausted plan, credit or spend limit. */
const QUOTA_EXHAUSTED_TEXT = [
  phrasePair("reached your", "\\blimit\\b"),
  /out of usage credits/i,
  phrasePair("hit your", "\\b(?:budget|spend limit|limit)\\b"),
  phrasePair("used your included", "usage"),
];

/**
 * A Claude Code session's rate-limit facts: the account usage windows `rate_limit_event` records
 * report, and the latest such event of the current session, which says whether a `rate_limit`
 * error is the account's quota running out (SDKRateLimitEvent and SDKAssistantMessageError,
 * https://code.claude.com/docs/en/agent-sdk/typescript.md). The order of a rejected event and its
 * assistant error is not documented, so only an event seen before the error counts.
 */
export class ClaudeRateLimitState {
  readonly #now: () => number;
  #usage: UsageSnapshot = { provider: RUNTIME_PROVIDER.CLAUDE_CODE };
  /** The latest event's reset, with the session it arrived in, while that event is rejected. */
  #rejected: { sessionId: string | undefined; resetsAt?: Date } | undefined;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  /** Remembers a `rate_limit_event` record, and returns the updated usage snapshot when it
   * reports a usage window. */
  observe(
    record: Readonly<Record<string, unknown>>,
    sessionId: string | undefined,
  ): UsageSnapshot | undefined {
    const info = asRecord(record.rate_limit_info);
    const resetsAt = resetTime(info?.resetsAt);
    // Only an event that says where the account stands replaces the remembered one.
    if (typeof info?.status === "string" && info.status)
      this.#rejected = info.status === "rejected" ? { sessionId, resetsAt } : undefined;
    const usageWindow = claudeRateLimitWindow(info, resetsAt);
    if (!usageWindow) return undefined;
    this.#usage = { ...this.#usage, [usageWindow.key]: usageWindow.window };
    return this.#usage;
  }

  /** The error event, with the limit it reports when it carries a Claude error code that names
   * one. */
  annotate(event: FailureEvent, sessionId: string | undefined): FailureEvent {
    const providerLimit = this.#limitOf(event.providerErrorCode, event.message, sessionId);
    return providerLimit ? { ...event, providerLimit } : event;
  }

  #limitOf(
    code: string | undefined,
    message: string,
    sessionId: string | undefined,
  ): ProviderLimit | undefined {
    if (code === "billing_error") return { kind: "quota_exhausted" };
    if (code !== "rate_limit") return undefined;
    const rejected = this.#rejected?.sessionId === sessionId ? this.#rejected : undefined;
    // A `rate_limit` code is a usage window's cap (five-hour, weekly), never the balance:
    // `billing_error` owns that. With or without a reset the daemon waits it out.
    if (rejected?.resetsAt && rejected.resetsAt.getTime() > this.#now())
      return { kind: "window_limit", resetsAt: rejected.resetsAt.toISOString() };
    if (rejected && !rejected.resetsAt) return { kind: "window_limit" };
    return QUOTA_EXHAUSTED_TEXT.some((pattern) => pattern.test(message))
      ? { kind: "window_limit" }
      : { kind: "transient_rate_limit" };
  }
}

/** A `resetsAt` in epoch seconds (as documented) or milliseconds. */
function resetTime(value: unknown): Date | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const reset = new Date(value >= 1e12 ? value : value * 1_000);
  return Number.isNaN(reset.getTime()) ? undefined : reset;
}

const WARNING_UTILIZATION_PERCENT = 75;
const NEAR_EXHAUSTED_UTILIZATION_PERCENT = 90;

function fractionToPercent(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return Math.min(100, Math.round(value * 100));
}

function quotaLevelOf(
  status: "allowed" | "allowed_warning" | "rejected",
  usedPercent: number | undefined,
  surpassedThreshold: unknown,
): NonNullable<UsageSnapshot["primary"]>["quotaLevel"] {
  if (status === "rejected") return "exhausted";
  const thresholdPercent = fractionToPercent(surpassedThreshold);
  const effectivePercent =
    usedPercent !== undefined && thresholdPercent !== undefined
      ? Math.max(usedPercent, thresholdPercent)
      : (usedPercent ?? thresholdPercent);
  if (
    (effectivePercent !== undefined && effectivePercent >= NEAR_EXHAUSTED_UTILIZATION_PERCENT) ||
    (surpassedThreshold === true && usedPercent === undefined)
  )
    return "near_exhausted";
  if (
    status === "allowed_warning" ||
    (effectivePercent !== undefined && effectivePercent >= WARNING_UTILIZATION_PERCENT)
  )
    return "warning";
  return effectivePercent !== undefined ? "ok" : undefined;
}

function claudeRateLimitWindow(
  info: Record<string, unknown> | undefined,
  reset: Date | undefined,
):
  | {
      key: "primary" | "secondary";
      window: NonNullable<UsageSnapshot["primary"]>;
    }
  | undefined {
  const status = info?.status;
  if (status !== "allowed" && status !== "allowed_warning" && status !== "rejected")
    return undefined;
  const key =
    info?.rateLimitType === "five_hour"
      ? "primary"
      : info?.rateLimitType === "seven_day"
        ? "secondary"
        : undefined;
  if (!key) return undefined;
  if (!reset && status !== "allowed_warning") return undefined;
  const usedPercent = fractionToPercent(info?.utilization);
  const quotaLevel = quotaLevelOf(status, usedPercent, info?.surpassedThreshold);
  return {
    key,
    window: {
      status: status === "rejected" ? "limit_reached" : "ok",
      ...(quotaLevel ? { quotaLevel } : {}),
      ...(usedPercent !== undefined ? { usedPercent } : {}),
      windowDurationMinutes: key === "primary" ? 300 : 10_080,
      ...(reset ? { resetsAt: reset.toISOString() } : {}),
    },
  };
}
