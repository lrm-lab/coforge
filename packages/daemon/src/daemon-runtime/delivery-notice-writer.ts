/**
 * Where a delivery's notice is written into an Agent's process (task #14). Who writes it depends on
 * who owns the message: the unread loop writes every reliable delivery, because it holds the batch
 * and retries on one state machine; a Memory Agent's notice and a tracked @mention's are written
 * here, by the mechanisms that own them. The rule is one writer per message — not one writer in the
 * daemon — so a delivery that is both is written exactly once.
 */
import type { NoticeMessage } from "./accepted-message-notices";
import { AgentNoticeSuppressedError, type AgentConversationScope } from "@coforge/agent";
import { getLogger } from "@logtape/logtape";
import { setContextViewMessageIds } from "./context-view-runtime-wiring";
import { countDistinctMessages } from "./agent-history-read";
import { planDeliveryNotice } from "./delivery-notice";
import { DELIVERY_IMPORTANCE, deliveryImportance } from "./delivery-importance";
import type { AgentConsumedSeqPort } from "#src/persistence/agent-consumed-seq-store";
import { diagnosticErrorName, type AgentMessageDelivery } from "@lrm/coforge-sdk/internal";
import { markNoticeAccepted } from "./agent-message-attention-index-helpers";
import { isTrackedMention } from "./mention-delivery-tracker";
import { AgentWakeupUnavailableError, noticeGeneration } from "./agent-wakeup-unavailable-error";
import type { AgentMessageAttentionIndex, MessageAttention } from "./agent-message-attention-index";

const logger = getLogger(["coforge", "daemon", "message-attention"]);

/**
 * The daemon's delivery queue, as the notice path uses it: whether a delivery waits, the
 * synchronous busy marker, the queue's own contents for a notice to count, and the Agent's
 * durable cursor. Declared here, structurally, so the index can keep the field private: a class
 * may hand a private field to a function, and no caller can reach the queue through the index.
 */
export type AgentDeliveryQueue = {
  shouldHold(agentId: string): boolean;
  enqueue(agentId: string, message: AgentMessageDelivery): void;
  busy(agentId: string): void;
  /** Admission resolved or rejected; this is not a turn outcome. */
  noticeSettled?(agentId: string): void;
  noticeAccepted?(agentId: string, messages: readonly NoticeMessage[]): void;
  /** The deliveries held for this Agent that it has not been shown yet. The notice counts
   * these, so its number is always a count of messages the daemon is holding right now rather
   * than a running total it would have to invalidate later. Concrete deliveries rather than a
   * number because one message can be held as more than one delivery, and a notice must
   * count messages, not deliveries. Optional: a composition without a delivery queue holds
   * nothing. */
  queued?(agentId: string): readonly AgentMessageDelivery[];
  /** The Agent's durable consumed cursor (its state database). Without it the index is
   * exactly as volatile as it was: the cursor then only lives as long as this process. */
  consumedSeqs?: AgentConsumedSeqPort;
  /** A line owed before the next notice, with its newline; empty when none. */
  noticePrefix?(agentId: string): string;
  /** The unread loop's door (task #14): a reliable delivery enters the loop here instead of being
   * written by this path, because the loop is that tier's only writer — it keeps the batch and
   * composes afresh at each attempt. The returned promise is that first attempt: it rejects when the
   * session refused the notice, which this path must pass on. Absent in a composition without a
   * loop, and then this path writes the notice itself. */
  unread?(announced: readonly AgentMessageDelivery[]): Promise<void> | void;
};

/** The facts a delivery notice is written from: the index lends these, and keeps its own. */
export type DeliveryNoticeHost = Pick<
  AgentMessageAttentionIndex,
  "previewSeen" | "noticeActionClocks" | "session" | "isCurrentGeneration" | "noticeEligibility"
> & {
  hold: AgentDeliveryQueue;
  generation(agentId: string): ReturnType<typeof noticeGeneration>;
  messageReceived(agentId: string, conversation?: AgentConversationScope): void;
  acceptNotice(signal: AbortSignal, send: () => Promise<void>): Promise<void>;
  recordAccepted(deliveries: readonly AgentMessageDelivery[]): boolean;
};

/**
 * One line per target, in the order the targets first appear: what this notice announces (`new`)
 * and what stays queued for this Agent (`held`). The delivery queue is per Agent, so a coalesced
 * flush can mix a channel, a DM and a thread; attributing the whole batch to the last delivery's
 * target would hide the others.
 *
 * `held` is a fact only this daemon has: those messages have not been shown to the model yet.
 * They are presented again when the queue releases them, unless a read covers them first.
 */
export function writeDeliveryNotice(
  this: DeliveryNoticeHost,
  message: AgentMessageDelivery,
  attention?: MessageAttention,
  /** The messages this notice announces: one delivery, or a coalesced flush's whole batch. */
  announced: readonly AgentMessageDelivery[] = [message],
): Promise<void> {
  const generation = this.generation(message.agentId);
  const session = this.session(message.agentId);
  if (!session?.notify)
    throw new AgentWakeupUnavailableError("Agent session cannot receive a wakeup notice");
  if (!message.target) return Promise.reject(new Error("delivery target is missing"));
  setContextViewMessageIds(
    session,
    announced.map((item) => item.messageId),
  );
  this.hold.busy(message.agentId);
  // A reliable delivery has one writer, the unread loop (task #14): it holds the batch, composes
  // from it at every attempt, and retries until the Agent reads it. Handing the batch over here —
  // at the one place this path would have written a notice — keeps the decision (who is told) with
  // the index and the writing (when, how often, in what words) with the loop, without a second
  // notice for the same message. The loop wrote this first attempt into the session just now, so
  // the delivery counts as told; the retries that follow are the loop's.
  //
  // A tracked @mention keeps this writer instead: the rule is one writer per message rather than one
  // writer in the daemon. Its notice names its deliveries to the session (`deliveryIds`) and its
  // retries are the mention tracker's, not the loop's; routing it there would take the notice away
  // from the mechanism that guarantees it.
  const tracked = announced.some((item) => isTrackedMention(item));
  if (
    deliveryImportance(message) === DELIVERY_IMPORTANCE.RELIABLE &&
    this.hold.unread &&
    !tracked
  ) {
    // The loop's first attempt is awaited here, so a session that refuses the notice still fails
    // the delivery: the caller does not acknowledge what nobody was told. It is raced against the
    // generation's cancellation like every other notice, so a stop settles this delivery instead of
    // leaving it waiting on a process that is going away.
    const handover = this.acceptNotice(generation.cancellation.signal, async () => {
      await this.hold.unread!(announced);
    })
      .then(() => {
        if (this.isCurrentGeneration(message.agentId, generation)) {
          markNoticeAccepted(generation, announced);
          this.noticeActionClocks.noteNoticeAccepted(message.agentId);
          this.messageReceived(message.agentId);
        }
        logger.info("Agent accepted inbox notice", {
          event: "agent.inbox_notice.accepted",
          request_id: message.requestId,
          workspace_id: message.workspaceId,
          agent_id: message.agentId,
          target_count: announced.length,
          pending_count: countDistinctMessages(announced),
          outcome: "ok",
        });
      })
      .catch((error: unknown) => {
        if (error instanceof AgentNoticeSuppressedError) return;
        logger.error("Agent rejected inbox notice", {
          event: "agent.inbox_notice.rejected",
          request_id: message.requestId,
          workspace_id: message.workspaceId,
          agent_id: message.agentId,
          target_count: announced.length,
          pending_count: countDistinctMessages(announced),
          error_code: diagnosticErrorName(error),
          outcome: "failed",
        });
        throw error;
      })
      .finally(() => {
        if (this.session(message.agentId) === session) this.hold.noticeSettled?.(message.agentId);
        if (this.isCurrentGeneration(message.agentId, generation))
          generation.notificationAttempts.delete(message.deliveryId);
      });
    // A redelivery that arrives while this attempt is in flight reuses it, so the loop is not asked
    // to say the same thing twice.
    generation.notificationAttempts.set(message.deliveryId, handover);
    return handover;
  }
  void attention;
  const current = planDeliveryNotice({
    agentId: message.agentId,
    announced,
    queued: this.hold.queued?.(message.agentId) ?? [],
    prefix: this.hold.noticePrefix?.(message.agentId) ?? "",
    eligibility: this.noticeEligibility,
    previewedInFull: (target, sequence) => this.previewSeen.has(message.agentId, target, sequence),
  });
  const identity = {
    request_id: message.requestId,
    workspace_id: message.workspaceId,
    agent_id: message.agentId,
    attempt_id: crypto.randomUUID(),
    source: "indexed" as const,
  };
  let selected = current();
  const refresh = (boundary: "admission" | "prompt" | "steer" | "fallback") => {
    selected = current();
    logger.info("Inbox notice submission decided", {
      ...identity,
      event: "agent.inbox_notice.submission_decision",
      boundary,
      outcome: selected ? "submit" : "suppress",
    });
    return selected?.notice;
  };
  const notification = Promise.resolve()
    .then(() => {
      if (!this.isCurrentGeneration(message.agentId, generation))
        throw new AgentWakeupUnavailableError("Agent notice was cancelled");
      const notice = refresh("admission");
      if (notice === undefined || !selected) throw new AgentNoticeSuppressedError();
      logger.info("Inbox notice handed to the session", {
        ...identity,
        event: "agent.inbox_notice.admission_requested",
      });
      const { trackedIds, deliveries } = selected;
      return this.acceptNotice(generation.cancellation.signal, () =>
        session.notify!(notice, {
          ...(trackedIds.length ? { deliveryIds: trackedIds } : {}),
          fallbackText: () => refresh("fallback"),
          noticeOrigin: {
            source: identity.source,
            attemptId: identity.attempt_id,
            deliveries,
          },
          prepareSubmission: refresh,
          onPromptWritten: () =>
            logger.info("ACP prompt written for inbox notice", {
              ...identity,
              event: "agent.inbox_notice.acp_prompt_written",
            }),
        }).then(async () => {
          await session.waitForContextViewCapture?.();
        }),
      );
    })
    .then(() => {
      if (!selected) return;
      if (this.isCurrentGeneration(message.agentId, generation)) {
        markNoticeAccepted(generation, selected.announced);
        if (this.recordAccepted(selected.announced))
          this.previewSeen.record(message.agentId, selected.shown);
        this.noticeActionClocks.noteNoticeAccepted(message.agentId);
        this.messageReceived(message.agentId);
      }
      logger.info("Agent accepted inbox notice", {
        ...identity,
        event: "agent.inbox_notice.accepted",
        target_count: selected.rows.length,
        pending_count: countDistinctMessages(selected.announced),
        total_pending_count: selected.totalCount,
        outcome: "ok",
      });
    })
    .catch((error: unknown) => {
      if (error instanceof AgentNoticeSuppressedError) return;
      logger.error("Agent rejected inbox notice", {
        ...identity,
        event: "agent.inbox_notice.rejected",
        target_count: selected?.rows.length ?? 0,
        pending_count: countDistinctMessages(selected?.announced ?? []),
        total_pending_count: selected?.totalCount ?? 0,
        error_code: diagnosticErrorName(error),
        outcome: "failed",
      });
      throw error;
    })
    .finally(() => {
      if (this.session(message.agentId) === session) this.hold.noticeSettled?.(message.agentId);
      if (this.isCurrentGeneration(message.agentId, generation))
        generation.notificationAttempts.delete(message.deliveryId);
    });
  generation.notificationAttempts.set(message.deliveryId, notification);
  return notification;
}
