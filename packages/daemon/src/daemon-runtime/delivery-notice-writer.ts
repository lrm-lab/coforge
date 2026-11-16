import type { AgentConversationScope } from "@coforge/agent";
import { getLogger } from "@logtape/logtape";
import { setContextViewMessageIds } from "./context-view-runtime-wiring";
import { countDistinctMessages } from "./agent-history-read";
import { composeDeliveryNotice } from "./delivery-notice";
import { diagnosticErrorName, type AgentMessageDelivery } from "@lrm/coforge-sdk/internal";
import { markNotified } from "./agent-message-attention-index-helpers";
import { AgentWakeupUnavailableError, noticeGeneration } from "./agent-wakeup-unavailable-error";
import type { AgentMessageAttentionIndex, MessageAttention } from "./agent-message-attention-index";

const logger = getLogger(["coforge", "daemon", "message-attention"]);

/** The facts a delivery notice is written from: the index lends these, and keeps its own. */
export type DeliveryNoticeHost = Pick<
  AgentMessageAttentionIndex,
  "hold" | "previewSeen" | "noticeActionClocks" | "session" | "isCurrentGeneration"
> & {
  generation(agentId: string): ReturnType<typeof noticeGeneration>;
  messageReceived(agentId: string, conversation?: AgentConversationScope): void;
  acceptNotice(signal: AbortSignal, send: () => Promise<void>): Promise<void>;
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
  void attention;
  const queued = this.hold.queued?.(message.agentId) ?? [];
  const { view, rows, totalCount, notice, trackedIds } = composeDeliveryNotice({
    message,
    announced,
    queued,
    prefix: this.hold.noticePrefix?.(message.agentId) ?? "",
    previewedInFull: (target, sequence) => this.previewSeen.has(message.agentId, target, sequence),
  });
  const notification = Promise.resolve()
    .then(() => {
      if (!this.isCurrentGeneration(message.agentId, generation))
        throw new AgentWakeupUnavailableError("Agent notice was cancelled");
      return this.acceptNotice(generation.cancellation.signal, () =>
        (trackedIds.length
          ? session.notify!(notice, { deliveryIds: trackedIds })
          : session.notify!(notice)
        ).then(async () => {
          await session.waitForContextViewCapture?.();
        }),
      );
    })
    .then(() => {
      if (this.isCurrentGeneration(message.agentId, generation)) {
        markNotified(generation, [message]);
        this.previewSeen.record(message.agentId, view.whole);
        this.noticeActionClocks.noteNoticeAccepted(message.agentId);
        this.messageReceived(message.agentId);
      }
      logger.info("Agent accepted inbox notice", {
        event: "agent.inbox_notice.accepted",
        request_id: message.requestId,
        workspace_id: message.workspaceId,
        agent_id: message.agentId,
        target_count: rows.length,
        pending_count: countDistinctMessages(announced),
        total_pending_count: totalCount,
        outcome: "ok",
      });
    })
    .catch((error: unknown) => {
      logger.error("Agent rejected inbox notice", {
        event: "agent.inbox_notice.rejected",
        request_id: message.requestId,
        workspace_id: message.workspaceId,
        agent_id: message.agentId,
        target_count: rows.length,
        pending_count: countDistinctMessages(announced),
        total_pending_count: totalCount,
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
