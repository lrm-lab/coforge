import { AGENT_ACTIVITY_DETAIL_KIND, type AgentActivity } from "@lrm/coforge-sdk/internal";
import type { RuntimeSweeps } from "./runtime-sweeps";
import type { AgentRuntimeConfig } from "@lrm/coforge-anvil";
import type { DaemonConnectionClient } from "#src/connection/daemon-connection-client";
import { unreadNoticeComposer } from "./important-unread-compose";
import type { AgentRuntime } from "#src/agent-runtime/agent-process-manager";
import type { AgentConsumedSeqStore } from "#src/persistence/agent-consumed-seq-store";
import type { AgentContexts } from "./agent-contexts";
import type { AgentDeliveryGate } from "./agent-delivery-gate";
import {
  AGENT_MESSAGE_REJECT_METHOD,
  type AgentDeliveryRejectionReason,
  type AgentMessageDelivery,
  type AgentMessageDeliveryRejection,
} from "@lrm/coforge-sdk/internal";
import type { AgentFeatureSync } from "./agent-feature-sync";
import type { AgentInboxCoordinator } from "./agent-inbox-coordinator";
import type { AgentLaunchCustody } from "./agent-launch-custody";
import type { AgentMessageAttentionIndex } from "./agent-message-attention-index";
import type { AgentMessageOperations } from "./agent-message-operations";
import type { AgentProcessManager } from "#src/agent-runtime/agent-process-manager";
import type { ActivityDraft, AgentActivityPublisher } from "./agent-activity-publisher";
import type { ActivityLaunch } from "./activity-launch";
import type { MentionDeliveryTracker } from "./mention-delivery-tracker";
import type { RunningMentionIdentity } from "./mention-delivery-ports";
import type { RuntimeRelease } from "./runtime-release";
import type { DaemonConfig } from "./runtime";
import { AgentInboxCoordinator as InboxCoordinator } from "./agent-inbox-coordinator";
import { AgentMessageAttentionIndex as MessageAttention } from "./agent-message-attention-index";
import { AgentMessageOperations as MessageOperations } from "./agent-message-operations";
import { ImportantUnreadNoticeStore } from "#src/persistence/important-unread-notice-store";
import { composeImportantUnreadReminder } from "./important-unread-wiring";
import { MentionDeliveryTracker as MentionDeliveries } from "./mention-delivery-tracker";
export type MessageCompositionPorts = {
  sweeps: Pick<RuntimeSweeps, "add">;
  connection: Pick<DaemonConfig, "workspaceId" | "computerId">;
  stateDirectory: string;
  transport(): DaemonConnectionClient;
  consumedSeqs: AgentConsumedSeqStore;
  deliveryGate: AgentDeliveryGate;
  runtimeRelease: RuntimeRelease<ActivityLaunch>;
  processManager: AgentProcessManager;
  launchCustody(): Pick<AgentLaunchCustody, "noteTurnStarted" | "ensureInput">;
  activityPublisher: AgentActivityPublisher<ActivityLaunch>;
  currentActivityLaunch(agentId: string): ActivityLaunch | undefined;
  activity(
    agentId: string,
    detailKind: AgentActivity["detailKind"],
    level: AgentActivity["level"],
    detail: string,
    extra?: Partial<ActivityDraft>,
  ): ActivityDraft;
  sync: Pick<AgentFeatureSync, "noticePrefix">;
  runningMentionIdentity(agentId: string, reported?: true): RunningMentionIdentity | undefined;
  contexts: AgentContexts;
  reconcileIdleTurn(agentId: string, launch: ActivityLaunch): boolean;
  startAgent(
    agentId: string,
    config: AgentRuntimeConfig,
    sessionId?: string,
  ): Promise<AgentRuntime>;
  assertRunning(): void;
  agentIdForContext(context: string): string;
};
export type MessageComposition = {
  mentionDeliveries: MentionDeliveryTracker;
  /** The unread loop the delivery guarantees hang off (task #14). */
  importantUnread: ReturnType<typeof composeImportantUnreadReminder>;
  messageAttention: AgentMessageAttentionIndex;
  inboxCoordinator: AgentInboxCoordinator;
  messageOperations: AgentMessageOperations;
};
export function composeMessages(ports: MessageCompositionPorts): MessageComposition {
  const { connection, transport } = ports;
  let messageAttention!: AgentMessageAttentionIndex;
  const mentionDeliveries = new MentionDeliveries(connection.computerId, {
    transition: (report) =>
      transport().sendAgentMentionDeliveryTransition?.(report) ?? Promise.resolve(),
    terminalError: (report) =>
      transport().sendAgentMentionDeliveryTerminalError?.(report) ?? Promise.resolve(),
    acknowledge: (message) => messageAttention.acknowledge(message),
    running: (agentId) => ports.runningMentionIdentity(agentId),
    consumed: (message) => messageAttention.hasConsumed(message),
    told: (message) => messageAttention.wasNotified(message),
    process: (agentId) => ports.processManager.session(agentId),
    relaunching: (agentId) => ports.runtimeRelease.isRecovering(agentId),
    remembered: (agentId) =>
      ports.processManager.restartConfig(agentId)
        ? ports.runningMentionIdentity(agentId, true)
        : undefined,
    pull: (agentId) => ports.launchCustody().ensureInput(agentId),
    decided: (message, outcome) => messageAttention.logDecision(message, outcome),
    announce: (message) => messageAttention.announce(message),
    announceBatch: async (messages, alongside) => {
      const batch = [...alongside, ...messages];
      if (batch.length === 0) return "told";
      await messageAttention.flush(batch[0]!.agentId, batch);
      return messages.every((message) => messageAttention.wasNotified(message)) ? "told" : "gone";
    },
    busy: (agentId) =>
      ports.processManager.session(agentId)?.hasLiveTurn === true ||
      ports.deliveryGate.isBusy(agentId),
    blocked: (agentId) =>
      ports.deliveryGate.explicitHold(agentId) ??
      (ports.deliveryGate.shouldHold(agentId) ? "queued_until_idle" : undefined),
  });
  messageAttention = new MessageAttention(
    connection.workspaceId,
    ports.processManager,
    (ack) => transport().sendAgentDeliveryAck?.(ack) ?? Promise.resolve(),
    (agentId, conversation) => {
      try {
        ports.activityPublisher.publishCurrent(
          agentId,
          ports.activity(
            agentId,
            AGENT_ACTIVITY_DETAIL_KIND.MESSAGE_RECEIVED,
            "info",
            "Message received",
            {
              entries: [],
              ...(conversation
                ? {
                    conversationId: conversation.conversationId,
                    conversationTarget: conversation.target,
                  }
                : {}),
            },
          ),
        );
        const launch = ports.currentActivityLaunch(agentId);
        if (launch) ports.reconcileIdleTurn(agentId, launch);
      } catch {}
    },
    {
      shouldHold: (agentId) => ports.deliveryGate.shouldHold(agentId),
      queued: (agentId) => ports.deliveryGate.pending(agentId),
      enqueue: (agentId, message) => ports.deliveryGate.enqueue(agentId, message),
      busy: (agentId) => {
        if (!ports.deliveryGate.isBusy(agentId))
          ports.launchCustody().noteTurnStarted(agentId, "delivery");
        ports.deliveryGate.busy(agentId);
      },
      noticeSettled: (agentId) => {
        const launch = ports.currentActivityLaunch(agentId);
        if (launch) ports.reconcileIdleTurn(agentId, launch);
      },
      consumedSeqs: {
        read: (agentId) => ports.consumedSeqs.read(agentId),
        write: (agentId, state) => {
          ports.consumedSeqs.write(agentId, state);
          mentionDeliveries.settleConsumed(agentId);
        },
      },
      noticePrefix: (agentId) => ports.sync.noticePrefix(agentId),
      // Task #14: a reliable delivery has one writer, the unread loop. The index hands the batch
      // over instead of writing its own notice, and the loop keeps it until the Agent reads it.
      unread: (announced) => importantUnread.observeDeliveries(announced),
    },
  );
  ports.contexts.onNewContext((agentId) => messageAttention.clearPreviewSeen(agentId));
  const inboxCoordinator = new InboxCoordinator({
    workspaceId: connection.workspaceId,
    stateDirectory: ports.stateDirectory,
    consumedSeqs: ports.consumedSeqs,
    messageAttention,
    deliveryGate: ports.deliveryGate,
    runtimeRelease: ports.runtimeRelease,
    processManager: ports.processManager,
    startAgent: (agentId, config, sessionId) => ports.startAgent(agentId, config, sessionId),
    currentActivityLaunch: (agentId) => ports.currentActivityLaunch(agentId),
    reconcileIdleTurn: (agentId, launch) => ports.reconcileIdleTurn(agentId, launch),
    mentionDeliveries,
    assertRunning: () => ports.assertRunning(),
    agentIdForContext: (context) => ports.agentIdForContext(context),
  });
  // Task #14: the unread loop. It writes into whichever session the Agent has and reports a batch
  // whose retries ran out as one error, so "written but nobody read it" cannot pass unnoticed.
  const importantUnread = composeImportantUnreadReminder({
    store: new ImportantUnreadNoticeStore(() => ports.stateDirectory),
    session: (agentId) => ports.processManager.session(agentId),
    unread: (agentId) => messageAttention.unreadDeliveries(agentId),
    // Every attempt asks for the notice again: the batch's own messages plus whatever waits in the
    // queue now, so a retry counts what arrived meanwhile instead of repeating a stale snapshot.
    compose: unreadNoticeComposer({
      queued: (agentId) => ports.deliveryGate.pending(agentId),
      prefix: (agentId) => ports.sync.noticePrefix(agentId),
      previewedInFull: (agentId, target, sequence) =>
        messageAttention.previewSeen.has(agentId, target, sequence),
    }),
    // An accepted attempt showed the model these bodies; a later attempt does not repeat them.
    shown: (agentId, shown) => messageAttention.previewSeen.record(agentId, shown),
    report: (agentId, notice) => {
      const launch = ports.currentActivityLaunch(agentId);
      if (!launch) return;
      const where = notice.conversations
        .flatMap((conversation) => (conversation.target ? [conversation.target] : []))
        .join(", ");
      ports.activityPublisher.publish(
        agentId,
        launch,
        ports.activity(
          agentId,
          AGENT_ACTIVITY_DETAIL_KIND.SYSTEM_MESSAGE,
          "error",
          `Unread important messages were announced ${notice.attempts} times and never read: ${where}.`,
        ),
      );
    },
  });
  // A starting Daemon takes over what the last process left; the first sweep tells the Agent.
  importantUnread.restore();

  const messageOperations = new MessageOperations({
    connection: { workspaceId: connection.workspaceId, computerId: connection.computerId },
    attention: messageAttention,
    contexts: ports.contexts,
    inbox: (agentId) => inboxCoordinator.agentInbox(agentId),
    appItemsPending: (agentId) => inboxCoordinator.appItemsPending(agentId),
    get transport() {
      return transport();
    },
    reportFreshnessHold: (agentId, activity) =>
      ports.activityPublisher.publishCurrent(
        agentId,
        ports.activity(
          agentId,
          AGENT_ACTIVITY_DETAIL_KIND.FRESHNESS_HOLD,
          "info",
          activity.detail,
          {
            activityKind: activity.activityKind,
            entries: activity.entries,
            producerFactId: activity.producerFactId,
          },
        ),
      ),
  });
  return {
    mentionDeliveries,
    messageAttention,
    inboxCoordinator,
    messageOperations,
    importantUnread,
  };
}
export function agentDeliveryRejection(
  message: AgentMessageDelivery,
  reason: AgentDeliveryRejectionReason,
): AgentMessageDeliveryRejection {
  return {
    protocolMajor: message.protocolMajor,
    requestId: message.requestId,
    messageId: message.messageId,
    deliveryId: message.deliveryId,
    workspaceId: message.workspaceId,
    agentId: message.agentId,
    sequence: message.sequence,
    reason,
    method: AGENT_MESSAGE_REJECT_METHOD,
  };
}
