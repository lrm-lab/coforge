import type { NoticeEligibility } from "./notice-eligibility";
import { isCardEvent } from "./agent-message-attention-index-helpers";
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
  lastSequence?: number;
  independentEvent?: true;
  /** How many important deliveries it holds, after merging. */
  count: number;
}>;

export type ImportantUnreadNotice = Readonly<{
  agentId: string;
  /** The batch's identity: stable while nothing important is added, idempotent across restarts. */
  key: string;
  highestSequence: number;
  conversations: readonly UnreadNoticeConversation[];
  attempts: number;
  lastAttempt?: ImportantUnreadAttemptOutcome;
  writtenAtMs?: number;
  /** When the next attempt is due; undefined while nothing is waiting to be retried. */
  nextAttemptAtMs?: number;
}>;

export function unreadConversationEligible(
  notice: ImportantUnreadNotice,
  conversation: UnreadNoticeConversation,
  eligibility: NoticeEligibility,
): boolean {
  if (conversation.independentEvent && notice.lastAttempt !== "accepted") return true;
  return (
    eligibility(notice.agentId, {
      target: conversation.target,
      conversationId: conversation.conversationId,
      sequence:
        conversation.lastSequence ??
        (conversation.count === 1 ? conversation.firstSequence : notice.highestSequence),
      ...(conversation.count > 1 ? { through: true } : {}),
    }).disposition === "notify"
  );
}

export type ImportantUnreadAttemptOutcome = "accepted" | "rejected";

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
   * Folds one delivery in. Returns the batch when the Agent has something to hear — a delivery the
   * loop is now responsible for — and undefined for best-effort traffic.
   *
   * Every reliable delivery is something to say, whatever its sequence: sequences count within a
   * conversation, so a message from another conversation can arrive behind the batch's highest, and
   * a delivery this state swallowed is a notice nobody writes — the loop is the reliable tier's
   * only writer (task #14). It joins the batch, and the batch is due again from that moment.
   */
  observe(delivery: ImportantUnreadDelivery): ImportantUnreadNotice | undefined {
    if (deliveryImportance(delivery) !== DELIVERY_IMPORTANCE.RELIABLE) return undefined;
    const current = this.#notices.get(delivery.agentId);
    const highestSequence = Math.max(current?.highestSequence ?? 0, delivery.sequence);
    const next: ImportantUnreadNotice = {
      agentId: delivery.agentId,
      key: `seq:${highestSequence}`,
      highestSequence,
      conversations: merge(current?.conversations ?? [], delivery),
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

  recordAttempt(
    agentId: string,
    outcome: ImportantUnreadAttemptOutcome,
    nowMs = Date.now(),
  ): ImportantUnreadNotice | undefined {
    const notice = this.#notices.get(agentId);
    if (!notice) return undefined;
    const attempts = notice.attempts + 1;
    const delay = IMPORTANT_UNREAD_RETRY_DELAYS_MS[attempts - 1];
    const { nextAttemptAtMs: previousSchedule, ...rest } = notice;
    void previousSchedule;
    const next: ImportantUnreadNotice = {
      ...rest,
      attempts,
      lastAttempt: outcome,
      ...(outcome === "accepted" ? { writtenAtMs: nowMs } : {}),
      ...(delay === undefined ? {} : { nextAttemptAtMs: nowMs + delay }),
    };
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

  retainConversations(
    agentId: string,
    retain: (conversation: UnreadNoticeConversation) => boolean,
  ): ImportantUnreadNotice | undefined {
    const notice = this.#notices.get(agentId);
    if (!notice) return undefined;
    const conversations = notice.conversations.filter(retain);
    if (conversations.length === notice.conversations.length) return notice;
    if (!conversations.length) {
      this.#notices.delete(agentId);
      return undefined;
    }
    const next = {
      ...notice,
      conversations,
    };
    this.#notices.set(agentId, next);
    return next;
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
  const independentEvent = isCardEvent(delivery);
  const existing = merged.find(
    (entry) =>
      entry.conversationId === delivery.conversationId &&
      Boolean(entry.independentEvent) === independentEvent,
  );
  if (existing) {
    existing.firstSequence = Math.min(existing.firstSequence, delivery.sequence);
    if (existing.lastSequence !== undefined)
      existing.lastSequence = Math.max(existing.lastSequence, delivery.sequence);
    existing.count += 1;
    if (delivery.target !== undefined) existing.target = delivery.target;
  } else
    merged.push({
      conversationId: delivery.conversationId,
      ...(delivery.target === undefined ? {} : { target: delivery.target }),
      firstSequence: delivery.sequence,
      lastSequence: delivery.sequence,
      ...(independentEvent ? { independentEvent: true as const } : {}),
      count: 1,
    });
  return merged;
}
