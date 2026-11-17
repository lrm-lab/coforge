import type { WakeHint } from "@lrm/coforge-sdk/agent";
import type { OutboundResult } from "#src/server/egress/outbound-egress.server";

export const TRANSIENT_CAP_SECONDS = 5 * 60;
const RATE_LIMIT_CAP_SECONDS = 60 * 60;
export const REJECTED_DELAY_SECONDS = 60;
const BAD_REQUEST_BASE_SECONDS = 10 * 60;
const TRANSIENT_BASE_SECONDS = 5;
const RATE_LIMIT_BASE_SECONDS = 60;
const TEXT_TARGETS = 3;

const REJECTING = new Set([401, 404, 410]);

export type Outcome =
  | { kind: "delivered" }
  | { kind: "rejected"; error: string }
  | { kind: "retry"; error: string; delaySeconds: number };

function retryAfterSeconds(value: string | undefined, now: Date): number | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const at = Date.parse(trimmed);
  return Number.isNaN(at) ? undefined : Math.max(0, Math.ceil((at - now.getTime()) / 1000));
}

const backoff = (base: number, attempt: number, cap: number) =>
  Math.min(cap, base * 2 ** Math.min(attempt, 20));

export function noticeText(hints: readonly WakeHint[]): string {
  const unread = hints.reduce((sum, hint) => sum + hint.pendingCount, 0);
  const named = hints.map((hint) => hint.target ?? "a conversation");
  const shown = named.slice(0, TEXT_TARGETS).join(", ");
  const more = named.length > TEXT_TARGETS ? `, +${named.length - TEXT_TARGETS} more` : "";
  return `Inbox update: ${unread} unread in ${shown}${more}`;
}

export function classify(result: OutboundResult, attempt: number, now: Date): Outcome {
  const { status } = result;
  if (status >= 200 && status < 300) return { kind: "delivered" };
  const error = `http_${status}`;
  if (REJECTING.has(status)) return { kind: "rejected", error };
  const retryAfter = retryAfterSeconds(result.retryAfter, now);
  if (status === 429)
    return {
      kind: "retry",
      error,
      delaySeconds: Math.min(
        RATE_LIMIT_CAP_SECONDS,
        retryAfter ?? backoff(RATE_LIMIT_BASE_SECONDS, attempt, RATE_LIMIT_CAP_SECONDS),
      ),
    };
  if (status >= 500)
    return {
      kind: "retry",
      error,
      delaySeconds: Math.min(
        TRANSIENT_CAP_SECONDS,
        status === 503 && retryAfter !== undefined
          ? Math.max(1, retryAfter)
          : backoff(TRANSIENT_BASE_SECONDS, attempt, TRANSIENT_CAP_SECONDS),
      ),
    };
  return {
    kind: "retry",
    error,
    delaySeconds: backoff(BAD_REQUEST_BASE_SECONDS, attempt, RATE_LIMIT_CAP_SECONDS),
  };
}

export function transient(error: unknown, attempt: number): Outcome {
  const name = error instanceof Error && error.name === "TimeoutError" ? "timeout" : "network";
  return {
    kind: "retry",
    error: name,
    delaySeconds: backoff(TRANSIENT_BASE_SECONDS, attempt, TRANSIENT_CAP_SECONDS),
  };
}
