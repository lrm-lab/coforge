import type { PreviewedWhole } from "./inbox-preview-rows";
import { AgentNoticeSuppressedError, type AgentNoticeOptions } from "@coforge/agent";
import type { AgentMessageDelivery } from "@lrm/coforge-sdk/internal";
import { getLogger } from "@logtape/logtape";
import { isCardEvent } from "./agent-message-attention-index-helpers";
import { inboxPreviewLimit } from "./inbox-preview";
import type { NoticeEligibility } from "./notice-eligibility";
import type { ImportantUnreadNoticeStore } from "#src/persistence/important-unread-notice-store";
import {
  type ImportantUnreadAttemptOutcome,
  type ImportantUnreadDelivery,
  ImportantUnreadNotices,
  unreadConversationEligible,
  type ImportantUnreadNotice,
} from "./important-unread-notice";

const logger = getLogger(["coforge", "daemon", "message-attention"]);

/** One delivery as the loop keeps it: the reduced facts the state machine needs, plus — when it
 * comes from the delivery path — the message itself, which is what a notice previews. */
export type ImportantUnreadBatchDelivery = ImportantUnreadDelivery &
  Partial<Omit<AgentMessageDelivery, keyof ImportantUnreadDelivery>>;

/** The slice of the record this loop needs: keeping what a restart reads, and what it finds. */
export type ImportantUnreadRecord = Pick<ImportantUnreadNoticeStore, "save" | "clear" | "list">;

/** One attempt's notice: the words to write, and the messages whose whole text they put in front of
 * the model, recorded only once the write is accepted. */
export type ImportantUnreadComposedNotice = Readonly<{
  text: string;
  requestIds?: readonly string[];
  deliveries?: NonNullable<AgentNoticeOptions["noticeOrigin"]>["deliveries"];
  fallbackText?: () => string | undefined;
  prepareSubmission?: AgentNoticeOptions["prepareSubmission"];
  shown?: readonly PreviewedWhole[];
  accepted?(): boolean;
}>;

/** What writing a notice means to the rest of the daemon: put it into the Agent's process, and
 * tell a person when nothing more can be done. Both are the delivery path's own concerns. */
export type ImportantUnreadReminderPorts = Readonly<{
  /** Writes the notice into the Agent's process. `false` is a refusal this call already knows
   * about; a promise is the same verdict arriving later — resolved once the session accepted the
   * notice, rejected when it refused it. `attempt` is what `compose` built for this attempt. */
  write(
    agentId: string,
    notice: ImportantUnreadNotice,
    attempt?: ImportantUnreadComposedNotice,
  ): boolean | Promise<void>;
  /** The Agent's running session, read for its identity alone: a batch written into one session is
   * not the next one's business. */
  session?(agentId: string): unknown;
  /** The notice as it reads now, from the Agent's current unread — never a snapshot of the first
   * attempt, so a retry fifteen minutes later counts what has arrived since. Undefined when there is
   * nothing to build it from. */
  compose?(
    agentId: string,
    notice: ImportantUnreadNotice,
    /** What this batch announced, oldest first. */
    deliveries: readonly ImportantUnreadBatchDelivery[],
  ): ImportantUnreadComposedNotice | undefined;
  /** The retries are used up and the Agent has not read: one error, once per batch. */
  report(agentId: string, notice: ImportantUnreadNotice): void;
  eligibility?: NoticeEligibility;
}>;

/** Why a delivery the loop took in will never be shown to the model. */
export type UnobservedReason = "superseded" | "read_before_attempt" | "rejected" | "unread";

/**
 * The loop around one Agent's unread state: fold deliveries in, write the notice when it is due,
 * retry on the state's own schedule, and stop when the batch is read (task #14). The state owns
 * the identity and the schedule; the store owns what a restart needs; this only sequences them,
 * which is what keeps every caller from deciding again when to write.
 */
export class ImportantUnreadReminder {
  readonly #reported = new Map<string, string>();
  readonly #writing = new Map<string, Promise<void>>();
  readonly #batchRevision = new Map<string, symbol>();
  readonly #batches = new Map<string, ImportantUnreadBatchDelivery[]>();
  readonly #unshown = new Map<string, Set<string>>();
  readonly #writtenTo = new Map<string, unknown>();

  constructor(
    private readonly notices: ImportantUnreadNotices,
    private readonly store: ImportantUnreadRecord,
    private readonly ports: ImportantUnreadReminderPorts,
    private readonly now: () => number = Date.now,
  ) {}

  observeDeliveries(deliveries: readonly ImportantUnreadBatchDelivery[]): Promise<void> | void {
    let attempt: Promise<void> | void = undefined;
    const dirty = new Map<string, ImportantUnreadNotice>();
    let eligibleDelivery = false;
    for (const delivery of deliveries) {
      const decision = this.ports.eligibility?.(delivery.agentId, delivery);
      if (decision?.disposition === "settle") {
        logger.info("Read delivery omitted from reliable inbox notice", {
          event: "agent.inbox_notice.eligibility",
          agent_id: delivery.agentId,
          request_id: delivery.requestId,
          delivery_id: delivery.deliveryId,
          conversation_id: delivery.conversationId,
          sequence: delivery.sequence,
          disposition: decision.disposition,
          basis: decision.basis,
        });
        continue;
      }
      eligibleDelivery = true;
      this.#forgetStaleBatch(delivery.agentId);
      const notice = this.notices.observe(delivery);
      if (!notice) continue;
      this.#batchRevision.set(notice.agentId, Symbol());
      const batch = this.#batches.get(notice.agentId) ?? [];
      batch.push(delivery);
      const shown = inboxPreviewLimit();
      const evicted = batch.length > shown ? batch.splice(0, batch.length - shown) : [];
      this.#batches.set(notice.agentId, batch);
      const unshown = this.#unshown.get(notice.agentId) ?? new Set<string>();
      for (const dropped of evicted) {
        if (dropped.deliveryId === undefined) continue;
        unshown.delete(dropped.deliveryId);
        this.#warnUnobserved(notice.agentId, [dropped.deliveryId], notice.attempts, "superseded");
      }
      if (delivery.deliveryId !== undefined) unshown.add(delivery.deliveryId);
      this.#unshown.set(notice.agentId, unshown);
      dirty.set(notice.agentId, notice);
    }
    for (const notice of dirty.values()) this.store.save(notice);
    for (const agentId of dirty.keys()) {
      const writing = this.#writing.get(agentId);
      const write = () => this.#writeIfDue(agentId);
      attempt = (writing ? writing.then(write, write) : write()) ?? attempt;
    }
    if (deliveries.length && !eligibleDelivery)
      return Promise.reject(new AgentNoticeSuppressedError());
    return attempt;
  }

  consumed(agentId: string): void {
    const notice = this.notices.pending(agentId);
    const eligibility = this.ports.eligibility;
    if (!notice || !eligibility) return;
    const batch = this.#batches.get(agentId);
    const unshown = this.#unshown.get(agentId);
    const exactReads = new Map<string, number>();
    const remaining = new Map<string, number[]>();
    const scope = (row: { conversationId: string; target?: string }, independent: boolean) =>
      JSON.stringify([row.conversationId, row.target, independent]);
    if (batch) {
      const newBatch = batch.filter((delivery) => {
        const key = scope(delivery, isCardEvent(delivery));
        if (eligibility(agentId, delivery).disposition !== "settle") {
          const sequences = remaining.get(key) ?? [];
          sequences.push(delivery.sequence);
          remaining.set(key, sequences);
          return true;
        }
        exactReads.set(key, (exactReads.get(key) ?? 0) + 1);
        if (delivery.deliveryId && unshown?.delete(delivery.deliveryId)) {
          this.#warnUnobserved(
            agentId,
            [delivery.deliveryId],
            notice.attempts,
            "read_before_attempt",
          );
        }
        return false;
      });
      if (newBatch.length !== batch.length) this.#batches.set(agentId, newBatch);
    }

    const retained = this.notices.reconcileConversations(agentId, (conversation) => {
      if (!unreadConversationEligible(notice, conversation, eligibility)) return undefined;
      const key = scope(conversation, Boolean(conversation.independentEvent));
      const removed = exactReads.get(key) ?? 0;
      if (!removed) return conversation;
      const count = conversation.count - removed;
      if (count <= 0) return undefined;
      const known = remaining.get(key) ?? [];
      if (known.length !== count) return { ...conversation, count };
      return {
        ...conversation,
        count,
        firstSequence: Math.min(...known),
        lastSequence: Math.max(...known),
      };
    });

    if (!retained) {
      this.#warnUnobserved(agentId, unshown ?? [], notice.attempts, "read_before_attempt");
      this.#reported.delete(agentId);
      this.#batchRevision.delete(agentId);
      this.#batches.delete(agentId);
      this.#unshown.delete(agentId);
      this.#writtenTo.delete(agentId);
      this.store.clear(agentId);
    } else if (retained !== notice) {
      this.store.save(retained);
    }
  }

  restore(): void {
    for (const notice of this.store.list()) this.notices.restore(notice);
  }

  flushDue(): number {
    const agents = this.notices.agents();
    for (const agentId of agents)
      void Promise.resolve(this.#writeIfDue(agentId)).catch(() => undefined);
    return agents.length;
  }

  #writeIfDue(agentId: string): void | Promise<void> {
    const pendingWrite = this.#writing.get(agentId);
    if (pendingWrite) return pendingWrite;
    this.consumed(agentId);
    const notice = this.notices.pending(agentId);
    if (!notice) return;
    if (this.notices.dueForWrite(agentId, this.now())) {
      this.#forgetStaleBatch(agentId);
      const session = this.ports.session?.(agentId);
      const attempt = this.ports.compose?.(agentId, notice, this.#batches.get(agentId) ?? []);
      const revision = this.#batchRevision.get(agentId);
      const isCurrent = () => this.#batchRevision.get(agentId) === revision;
      const verdict = this.ports.write(agentId, notice, attempt);
      if (verdict !== true && verdict !== false) {
        const writing = verdict
          .then(
            () => {
              if (isCurrent()) this.#acceptAttempt(agentId, session);
            },
            (error: unknown) => {
              if (error instanceof AgentNoticeSuppressedError) this.consumed(agentId);
              else if (isCurrent()) this.#recordAttempt(agentId, "rejected");
              throw error;
            },
          )
          .finally(() => this.#writing.delete(agentId));
        this.#writing.set(agentId, writing);
        return writing;
      }
      if (!verdict) return;
      this.#acceptAttempt(agentId, session);
      return;
    }
    this.#reportIfSpent(agentId, notice);
  }

  #acceptAttempt(agentId: string, session: unknown): void {
    this.#unshown.delete(agentId);
    if (session !== undefined) this.#writtenTo.set(agentId, session);
    this.#recordAttempt(agentId, "accepted");
  }

  #recordAttempt(agentId: string, outcome: ImportantUnreadAttemptOutcome): void {
    const attempted = this.notices.recordAttempt(agentId, outcome, this.now());
    if (!attempted) return;
    this.store.save(attempted);
    this.#reportIfSpent(agentId, attempted);
  }

  #reportIfSpent(agentId: string, notice: ImportantUnreadNotice): void {
    if (!this.notices.retriesExhausted(agentId)) return;
    const spent = this.notices.pending(agentId) ?? notice;
    if (this.#reported.get(agentId) === spent.key) return;
    this.#reported.set(agentId, spent.key);
    this.#warnUnobserved(
      agentId,
      (this.#batches.get(agentId) ?? []).flatMap((delivery) =>
        delivery.deliveryId === undefined ? [] : [delivery.deliveryId],
      ),
      spent.attempts,
      spent.lastAttempt === "rejected" ? "rejected" : "unread",
    );
    this.ports.report(agentId, spent);
  }

  /** A batch written into a session that has since been replaced is not the new session's: its own
   * recovery says what is unread, so the loop keeps nothing to repeat. Not a dropped delivery — the
   * Agent is told by that recovery — so this is not the `unobserved` case. */
  #forgetStaleBatch(agentId: string): void {
    const written = this.#writtenTo.get(agentId);
    if (written === undefined || this.ports.session?.(agentId) === written) return;
    this.#batches.delete(agentId);
    this.#unshown.delete(agentId);
    this.#writtenTo.delete(agentId);
  }

  /** One line per delivery the loop took in and never put in front of the model: its own account of
   * what it could not deliver, so a notice that went missing can be found in the log. */
  #warnUnobserved(
    agentId: string,
    deliveryIds: Iterable<string>,
    attempts: number,
    reason: UnobservedReason,
  ): void {
    for (const deliveryId of deliveryIds)
      logger.warn("Agent never saw an inbox notice", {
        event: "agent.inbox_notice.unobserved",
        agent_id: agentId,
        delivery_id: deliveryId,
        attempts,
        reason,
      });
  }
}
