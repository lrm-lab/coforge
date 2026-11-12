import type { AgentMessageDelivery } from "@lrm/coforge-sdk/internal";
import { HELD_CONTEXT_LIMIT } from "@lrm/coforge-sdk/internal";
import type {
  AgentConsumedSeqEntry,
  AgentConsumedSeqState,
} from "#src/persistence/agent-consumed-seq-store";

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
 * answered or declined (`choice`) or expired (`expired`). The read state that already covers the
 * card cannot cover the event, so these always deserve a notice. */
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

/** Whether `receive` already recorded this delivery's attention: its id is in the remembered
 * window, or it is held (see `NoticeGeneration.recordedHeld`). */
export function attentionRecorded(
  generation: { seenDeliveryIds: ReadonlySet<string>; recordedHeld: ReadonlySet<string> },
  deliveryId: string,
): boolean {
  return generation.seenDeliveryIds.has(deliveryId) || generation.recordedHeld.has(deliveryId);
}

/**
 * Settles deliveries a notice of which was accepted. They stop being held only now: a Memory batch
 * whose notice failed is flushed again, and must still be known as recorded.
 */
export function markFlushed(
  generation: {
    seenDeliveryIds: ReadonlySet<string>;
    notified: Set<string>;
    recordedHeld: Set<string>;
  },
  flushed: readonly AgentMessageDelivery[],
): void {
  markNotified(generation, flushed);
  for (const message of flushed) generation.recordedHeld.delete(message.deliveryId);
}

/**
 * Marks deliveries as notified once a notice of them was accepted. `notified` only holds ids the
 * remembered window still holds, as `#remember` prunes it, so a notice accepted after the window
 * moved past its delivery, or a backlog flushed past the window, leaves no id behind that nothing
 * would ever forget.
 */
export function markNotified(
  generation: { seenDeliveryIds: ReadonlySet<string>; notified: Set<string> },
  accepted: readonly AgentMessageDelivery[],
): void {
  for (const message of accepted)
    if (generation.seenDeliveryIds.has(message.deliveryId))
      generation.notified.add(message.deliveryId);
}

export type ConsumedAgent = {
  targets: Map<string, ConsumedTarget>;
  aliases: Map<string, string>;
  lastReadOrder: number;
};
/** Exact sequences stay sorted above the frontier. reviewedSeq advances only for presented
 * review context, independently of consumption; readOrder compares reviews across targets. */
export type ConsumedTarget = {
  -readonly [K in keyof AgentConsumedSeqEntry]: AgentConsumedSeqEntry[K];
};

/** The durable snapshot of one Agent's consumed state: only what a cursor entry persists. */
export function consumedSnapshot(state: ConsumedAgent): AgentConsumedSeqState {
  const targets: Record<string, AgentConsumedSeqEntry> = {};
  for (const [target, entry] of state.targets) {
    const record: ConsumedTarget = {};
    if (entry.seq !== undefined) record.seq = entry.seq;
    if (entry.readOrder !== undefined) {
      record.readOrder = entry.readOrder;
      if (entry.reviewedSeq !== undefined) record.reviewedSeq = entry.reviewedSeq;
    }
    if (entry.exactSeqs?.length) record.exactSeqs = entry.exactSeqs;
    // A conversation binding by itself never made a persisted cursor entry.
    if (Object.keys(record).length === 0) continue;
    if (entry.conversationId !== undefined) record.conversationId = entry.conversationId;
    targets[target] = record;
  }
  return {
    targets,
    aliases: Object.fromEntries(state.aliases),
    nextReadOrder: state.lastReadOrder + 1,
  };
}
