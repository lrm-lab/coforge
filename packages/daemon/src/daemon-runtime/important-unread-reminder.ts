import type { AgentMessageDelivery } from "@lrm/coforge-sdk/internal";
import { getLogger } from "@logtape/logtape";
import { inboxPreviewLimit } from "./inbox-preview";
import type { ImportantUnreadNoticeStore } from "#src/persistence/important-unread-notice-store";
import {
  type ImportantUnreadAttemptOutcome,
  type ImportantUnreadDelivery,
  ImportantUnreadNotices,
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
  fallbackText?: () => string | undefined;
  shown?: readonly { target: string; sequence: number }[];
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
  /** Batches already reported as exhausted, so a sweep does not repeat the error. */
  readonly #reported = new Set<string>();
  /** The deliveries each batch announced, kept only in memory: they are how a later attempt still
   * knows which messages it is about. Only the ones a notice actually shows are kept — the count of
   * the rest is in the state — so a conversation that never stops cannot grow this without bound.
   * A record taken over after a restart has none, and composes from the queue alone. */
  readonly #batches = new Map<string, ImportantUnreadBatchDelivery[]>();
  /** The deliveries of each Agent's batch that no accepted notice has shown yet. A delivery that
   * leaves this without ever having been shown was taken in and never put in front of the model;
   * that is the one thing a silent drop looks like from inside, so each is warned about once. */
  readonly #unshown = new Map<string, Set<string>>();
  /** The session each Agent's batch was written into. A replacement session is told what is
   * unread by its own recovery, so the deliveries the old one held are not its business, and a
   * notice written for it names only what has arrived since. */
  readonly #writtenTo = new Map<string, unknown>();

  constructor(
    private readonly notices: ImportantUnreadNotices,
    private readonly store: ImportantUnreadRecord,
    private readonly ports: ImportantUnreadReminderPorts,
    private readonly now: () => number = Date.now,
  ) {}

  /** Folds new deliveries in and writes what they made due. Best-effort traffic is ignored by
   * the state itself, so callers need not pre-filter. The returned promise is the attempt this call
   * started, when its write reports its verdict later: its rejection belongs to the caller that
   * handed the delivery over. */
  observeDeliveries(deliveries: readonly ImportantUnreadBatchDelivery[]): Promise<void> | void {
    let attempt: Promise<void> | void = undefined;
    const agents: string[] = [];
    for (const delivery of deliveries) {
      this.#forgetStaleBatch(delivery.agentId);
      const notice = this.notices.observe(delivery);
      if (!notice) continue;
      // One pending notice per Agent, so the batch is the Agent's: a later arrival joins it rather
      // than starting another, which is what makes a retry count three instead of one.
      const batch = this.#batches.get(notice.agentId) ?? [];
      batch.push(delivery);
      const shown = inboxPreviewLimit();
      const evicted = batch.length > shown ? batch.splice(0, batch.length - shown) : [];
      this.#batches.set(notice.agentId, batch);
      const unshown = this.#unshown.get(notice.agentId) ?? new Set<string>();
      // Out of the batch is out of the notice: its own text will never be shown, so it is reported
      // once rather than silently forgotten.
      for (const dropped of evicted) {
        if (dropped.deliveryId === undefined) continue;
        unshown.delete(dropped.deliveryId);
        this.#warnUnobserved(notice.agentId, [dropped.deliveryId], notice.attempts, "superseded");
      }
      if (delivery.deliveryId !== undefined) unshown.add(delivery.deliveryId);
      this.#unshown.set(notice.agentId, unshown);
      this.store.save(notice);
      if (!agents.includes(notice.agentId)) agents.push(notice.agentId);
    }
    // What arrived together is one thing to say — a coalesced flush of five messages is one notice —
    // so the attempt comes after the batch is folded, once per Agent.
    for (const agentId of agents) attempt = this.#writeIfDue(agentId) ?? attempt;
    return attempt;
  }

  /** The Agent's read position moved: a batch it has passed is done and its record goes. */
  consumed(agentId: string, consumedThroughSequence: number): void {
    const notice = this.notices.pending(agentId);
    if (!this.notices.settle(agentId, consumedThroughSequence)) return;
    // Read before any attempt put these in front of the model: the reminder is being withdrawn, so
    // the fact that they never landed is worth a log line.
    if (notice)
      this.#warnUnobserved(
        agentId,
        this.#unshown.get(agentId) ?? [],
        notice.attempts,
        "read_before_attempt",
      );
    this.#reported.delete(agentId);
    this.#batches.delete(agentId);
    this.#unshown.delete(agentId);
    this.store.clear(agentId);
  }

  /** What a starting Daemon takes over: nothing is written here, only recorded, so the first
   * sweep of the new process tells the Agent once (task #14: the watchdog does not wait). */
  restore(): void {
    for (const notice of this.store.list()) this.notices.restore(notice);
  }

  /** Writes every notice whose schedule says it is due, and reports the ones that ran out. A
   * refusal here is nobody's rejection: the sweep is not the delivery that asked for it. Returns
   * how many Agents had a notice pending, so the sweep driving this can log the tick it took. */
  flushDue(): number {
    const agents = this.notices.agents();
    for (const agentId of agents)
      void Promise.resolve(this.#writeIfDue(agentId)).catch(() => undefined);
    return agents.length;
  }

  #writeIfDue(agentId: string): void | Promise<void> {
    const notice = this.notices.pending(agentId);
    if (!notice) return;
    if (this.notices.dueForWrite(agentId, this.now())) {
      this.#forgetStaleBatch(agentId);
      const session = this.ports.session?.(agentId);
      const attempt = this.ports.compose?.(agentId, notice, this.#batches.get(agentId) ?? []);
      const verdict = this.ports.write(agentId, notice, attempt);
      if (verdict !== true && verdict !== false)
        return verdict.then(
          () => this.#acceptAttempt(agentId, session),
          (error: unknown) => {
            this.#recordAttempt(agentId, "rejected");
            throw error;
          },
        );
      if (!verdict) return;
      this.#acceptAttempt(agentId, session);
      return;
    }
    this.#reportIfSpent(agentId, notice);
  }

  /** One accepted write: what the loop was holding for this Agent has been shown to the model, and
   * the next attempt, if any, is scheduled. */
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
    // A batch whose retries are used up is reported once, whatever the reason it stopped.
    if (!this.notices.retriesExhausted(agentId)) return;
    // The write above may be the one that spent the last retry, so the state is read again: the
    // count reported is the one the Agent was actually told, not the one before this attempt.
    const spent = this.notices.pending(agentId) ?? notice;
    const key = `${agentId} ${spent.key}`;
    if (this.#reported.has(key)) return;
    this.#reported.add(key);
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
