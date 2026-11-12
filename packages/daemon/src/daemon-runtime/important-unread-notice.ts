import { DELIVERY_IMPORTANCE, deliveryImportance } from "./delivery-importance";

/**
 * One Agent's pending "you have important unread messages", as one state rather than a ledger of
 * deliveries (task #14). The daemon guarantees an Agent eventually *knows* that it has important
 * unread work; it does not guarantee each message arrives.
 *
 * The identity is `(agentId, highest sequence)`: new important traffic only updates the state, and
 * the Agent is told again only when that identity changes. What the notice says is a batch — which
 * conversations hold important unread, and the oldest sequence in each — so a second message in a
 * conversation being read right now does not produce a second notice.
 */
export type UnreadNoticeConversation = Readonly<{
  conversationId: string;
  target?: string;
  /** The oldest important sequence still unread in this conversation. */
  firstSequence: number;
  /** How many important deliveries it holds, after merging. */
  count: number;
}>;

export type ImportantUnreadNotice = Readonly<{
  agentId: string;
  /** The batch's identity: stable while nothing important is added, idempotent across restarts. */
  key: string;
  highestSequence: number;
  conversations: readonly UnreadNoticeConversation[];
  /** How many times this batch's notice has been written into the Agent's process. */
  attempts: number;
  writtenAtMs?: number;
  /** When the next attempt is due; undefined while nothing is waiting to be retried. */
  nextAttemptAtMs?: number;
}>;

/** How long to wait before each retry; past them the state is left for the watchdog's owner. */
export const IMPORTANT_UNREAD_RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000] as const;

/** The fields the state is built from: a delivery's own account of itself. */
export type ImportantUnreadDelivery = Readonly<{
  agentId: string;
  conversationId: string;
  target?: string;
  sequence: number;
  mentionsAgent?: boolean;
  nonMemberMention?: boolean;
  taskExecutionSessionId?: string;
  reason?: string;
}>;

/**
 * The per-Agent state. Not persisted here: the store beside it writes what a restarted Daemon has
 * to know (the key, the batch and the attempts), and this class is what a live process decides on.
 */
export class ImportantUnreadNotices {
  readonly #notices = new Map<string, ImportantUnreadNotice>();

  /**
   * Folds one delivery in. Returns the notice when the Agent has something new to be told — a new
   * batch identity — and undefined when this delivery changes nothing (best-effort traffic, or a
   * sequence the batch already covers).
   */
  observe(delivery: ImportantUnreadDelivery): ImportantUnreadNotice | undefined {
    if (deliveryImportance(delivery) !== DELIVERY_IMPORTANCE.RELIABLE) return undefined;
    const current = this.#notices.get(delivery.agentId);
    if (current && delivery.sequence <= current.highestSequence) return undefined;
    const highestSequence = delivery.sequence;
    const next: ImportantUnreadNotice = {
      agentId: delivery.agentId,
      key: `seq:${highestSequence}`,
      highestSequence,
      conversations: merge(current?.conversations ?? [], delivery),
      // A new identity is a new thing to say: its own attempts start from zero.
      attempts: 0,
    };
    this.#notices.set(delivery.agentId, next);
    return next;
  }

  /** What this Agent still has to hear about, or undefined when it is caught up. */
  pending(agentId: string): ImportantUnreadNotice | undefined {
    return this.#notices.get(agentId);
  }

  /** Whether a notice is due now: never written, or a retry whose backoff has elapsed. */
  dueForWrite(agentId: string, nowMs = Date.now()): boolean {
    const notice = this.#notices.get(agentId);
    if (!notice) return false;
    if (notice.attempts > IMPORTANT_UNREAD_RETRY_DELAYS_MS.length) return false;
    return notice.nextAttemptAtMs === undefined || notice.nextAttemptAtMs <= nowMs;
  }

  /** Records one write of this batch's notice and schedules the next attempt, if any is left. */
  recordWritten(agentId: string, nowMs = Date.now()): ImportantUnreadNotice | undefined {
    const notice = this.#notices.get(agentId);
    if (!notice) return undefined;
    const attempts = notice.attempts + 1;
    // One write plus one per delay: the last write schedules nothing.
    const delay = IMPORTANT_UNREAD_RETRY_DELAYS_MS[attempts - 1];
    // The previous schedule is gone whatever happens: a spent retry must not leave a due time
    // behind, which is what would make a finished batch look like it is still waiting.
    const { nextAttemptAtMs: previousSchedule, ...rest } = notice;
    void previousSchedule;
    const next: ImportantUnreadNotice =
      delay === undefined
        ? { ...rest, attempts, writtenAtMs: nowMs }
        : { ...rest, attempts, writtenAtMs: nowMs, nextAttemptAtMs: nowMs + delay };
    this.#notices.set(agentId, next);
    return next;
  }

  /** True once every retry was used and nothing is scheduled: the watchdog's cue, not a silence. */
  retriesExhausted(agentId: string): boolean {
    const notice = this.#notices.get(agentId);
    return (
      notice !== undefined &&
      notice.attempts > IMPORTANT_UNREAD_RETRY_DELAYS_MS.length &&
      notice.nextAttemptAtMs === undefined
    );
  }

  /**
   * The Agent's read position moved. Only a position past the batch's highest sequence settles it:
   * having run a check without reading these messages is not having read them.
   */
  settle(agentId: string, consumedThroughSequence: number): boolean {
    const notice = this.#notices.get(agentId);
    if (!notice || consumedThroughSequence < notice.highestSequence) return false;
    this.#notices.delete(agentId);
    return true;
  }

  clear(agentId: string): void {
    this.#notices.delete(agentId);
  }

  /** The Agents with something still to hear about, for a sweep that writes what is due. */
  agents(): string[] {
    return [...this.#notices.keys()];
  }

  /** What a starting Daemon takes over from the record a previous process left. */
  restore(notice: ImportantUnreadNotice): void {
    if (notice.highestSequence <= 0 || notice.conversations.length === 0) return;
    this.#notices.set(notice.agentId, notice);
  }
}

/** Folds one delivery into the batch, keeping one entry per conversation and the oldest sequence. */
function merge(
  conversations: readonly UnreadNoticeConversation[],
  delivery: ImportantUnreadDelivery,
): UnreadNoticeConversation[] {
  const merged = conversations.map((entry) => ({ ...entry }));
  const existing = merged.find((entry) => entry.conversationId === delivery.conversationId);
  if (existing) {
    existing.firstSequence = Math.min(existing.firstSequence, delivery.sequence);
    existing.count += 1;
    if (delivery.target !== undefined) existing.target = delivery.target;
  } else
    merged.push({
      conversationId: delivery.conversationId,
      ...(delivery.target === undefined ? {} : { target: delivery.target }),
      firstSequence: delivery.sequence,
      count: 1,
    });
  return merged;
}
