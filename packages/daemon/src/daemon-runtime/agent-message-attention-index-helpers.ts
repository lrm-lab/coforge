import type { AgentMessageDelivery } from "@lrm/coforge-sdk/internal";
import { HELD_CONTEXT_LIMIT } from "@lrm/coforge-sdk/internal";

export const byNumber = (left: number, right: number) => left - right;

export function isAscending(values: readonly number[]): boolean {
  for (let i = 1; i < values.length; i++) if (values[i]! < values[i - 1]!) return false;
  return true;
}

/** The index of the first value above `bound` in an ascending list. */
export function firstAbove(values: readonly number[], bound: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (values[middle]! <= bound) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** Whether two thread roots name the same message: compared without case, and a short (8-hex)
 * root names the full root it begins. */
export function sameThreadRoot(left: string | undefined, right: string): boolean {
  if (left === undefined) return false;
  const a = left.toLowerCase();
  const b = right.toLowerCase();
  return a === b || (a.length < b.length ? b.startsWith(a) : a.startsWith(b));
}

/** Whether an ascending list holds `value`. */
export function containsSorted(values: readonly number[] | undefined, value: number): boolean {
  if (!values?.length) return false;
  const index = firstAbove(values, value - 1);
  return values[index] === value;
}

/** The deliveries that carry news about a message the Agent itself authored: its action card was
 * answered (`choice`) or expired (`expired`). The read state that already covers the card cannot
 * cover the event, so these always deserve a notice. */
const CARD_EVENT_REASONS: ReadonlySet<string> = new Set(["choice", "expired"]);

export function isCardEvent(message: { reason?: string }): boolean {
  return message.reason !== undefined && CARD_EVENT_REASONS.has(message.reason);
}

/**
 * Delivery and message ids remembered per Agent for duplicate suppression. The
 * oldest are forgotten first; a redelivery older than this window is treated
 * as new, which only costs one extra inbox notice.
 */
export const REMEMBERED_DELIVERIES = 4096;

/** How many of the newest unreviewed deliveries per target the index keeps for a locally decided
 * freshness hold to show: exactly `HELD_CONTEXT_LIMIT` (in the SDK's `freshness-decision.ts`),
 * because the hold shows the newest that many and no more — and anything older is consumed by the
 * same frontier anyway. No invented slack. */
export const PENDING_WINDOW_LIMIT = HELD_CONTEXT_LIMIT;

/** One unreviewed delivery plus the moment this daemon learned about it. Deliveries carry no
 * message timestamp of their own (only the server knows when a message was written), so the
 * arrival time is what a locally built preview can honestly show. */
export type PendingWindowEntry = { delivery: AgentMessageDelivery; receivedAt: number };
