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

export type AgentDeliveryQueue = {
  shouldHold(agentId: string): boolean;
  enqueue(agentId: string, message: AgentMessageDelivery): void;
  busy(agentId: string): void;
  noticeSettled?(agentId: string): void;
  noticeAccepted?(agentId: string, messages: readonly NoticeMessage[]): void;
  queued?(agentId: string): readonly AgentMessageDelivery[];
  consumedSeqs?: AgentConsumedSeqPort;
  onConsumed?(agentId: string): void;
  noticePrefix?(agentId: string): string;
  unread?(announced: readonly AgentMessageDelivery[]): Promise<void> | void;
};

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

export function writeDeliveryNotice(
  this: DeliveryNoticeHost,
  message: AgentMessageDelivery,
  attention?: MessageAttention,
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
  const tracked = announced.some((item) => isTrackedMention(item));
  if (
    deliveryImportance(message) === DELIVERY_IMPORTANCE.RELIABLE &&
    this.hold.unread &&
    !tracked
  ) {
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
    previewedInFull: (target, sequence, conversationId) =>
      this.previewSeen.has(message.agentId, target, sequence, conversationId),
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
