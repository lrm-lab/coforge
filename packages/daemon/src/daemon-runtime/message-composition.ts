import { AGENT_ACTIVITY_DETAIL_KIND, type AgentActivity } from "@lrm/coforge-sdk/internal";
import type { RuntimeSweeps } from "./runtime-sweeps";
import type { AgentRuntimeConfig } from "@lrm/coforge-anvil";
import type { DaemonConnectionClient } from "#src/connection/daemon-connection-client";
import { unreadNoticeComposer } from "./important-unread-compose";
import type { AgentRuntime } from "#src/agent-runtime/agent-process-manager";
import type { AgentConsumedSeqStore } from "#src/persistence/agent-consumed-seq-store";
import { FileAppNotifiedStore } from "#src/persistence/app-notified-store";
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
import { ImportantUnreadSweep } from "./important-unread-sweep";
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
  launchCustody(): Pick<AgentLaunchCustody, "noteTurnStarted" | "noteTurnInput" | "ensureInput">;
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
  importantUnread: ReturnType<typeof composeImportantUnreadReminder>;
  messageAttention: AgentMessageAttentionIndex;
  inboxCoordinator: AgentInboxCoordinator;
  messageOperations: AgentMessageOperations;
};
export function composeMessages(ports: MessageCompositionPorts): MessageComposition {
  const { connection, transport } = ports;
  let messageAttention!: AgentMessageAttentionIndex;
  let importantUnread!: MessageComposition["importantUnread"];
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
      ports.deliveryGate.wakeLoopHoldReason?.(agentId) ??
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
        ports.launchCustody().noteTurnInput(agentId);
        if (
          !ports.deliveryGate.isBusy(agentId) ||
          ports.processManager.session(agentId)?.hasLiveTurn === false
        )
          ports.launchCustody().noteTurnStarted(agentId, "delivery");
        ports.deliveryGate.busy(agentId);
      },
      noticeAccepted: (id, messages) => ports.contexts.noteMemoryActivity(id, messages),
      noticeSettled: (agentId) => {
        const launch = ports.currentActivityLaunch(agentId);
        if (launch) ports.reconcileIdleTurn(agentId, launch);
      },
      consumedSeqs: ports.consumedSeqs,
      onConsumed: (agentId) => {
        mentionDeliveries.settleConsumed(agentId);
        importantUnread.consumed(agentId);
      },
      noticePrefix: (agentId) => ports.sync.noticePrefix(agentId),
      unread: (announced) => importantUnread.observeDeliveries(announced),
    },
  );
  ports.contexts.onNewContext((agentId, runtime) => {
    messageAttention.clearPreviewSeen(agentId);
    if (runtime === undefined) messageAttention.resetNoticeContext(agentId);
    else messageAttention.beginNoticeContext(agentId);
  });
  const inboxCoordinator = new InboxCoordinator({
    workspaceId: connection.workspaceId,
    stateDirectory: ports.stateDirectory,
    notifiedAppItems: new FileAppNotifiedStore(ports.stateDirectory, connection.workspaceId),
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
  const importantUnreadStore = new ImportantUnreadNoticeStore(
    () => ports.stateDirectory,
    undefined,
    { asyncWrites: true },
  );
  importantUnread = composeImportantUnreadReminder({
    store: importantUnreadStore,
    eligibility: messageAttention.noticeEligibility,
    session: (agentId) => ports.processManager.session(agentId),
    unread: (agentId) => messageAttention.unreadDeliveries(agentId),
    compose: unreadNoticeComposer({
      eligibility: messageAttention.noticeEligibility,
      queued: (agentId) => ports.deliveryGate.pending(agentId),
      prefix: (agentId) => ports.sync.noticePrefix(agentId),
      previewedInFull: (agentId, target, sequence) =>
        messageAttention.previewSeen.has(agentId, target, sequence),
      captureAcceptance: (agentId) => messageAttention.captureNoticeAcceptance(agentId),
    }),
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
  importantUnread.restore();
  ports.sweeps.add(
    new ImportantUnreadSweep({
      flushDue: () => importantUnread.flushDue(),
      onStop: () => importantUnreadStore.flushSync(),
    }),
  );

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
    noteCoforgeWriteOrHold: (agentId) => inboxCoordinator.noteCoforgeWriteOrHold(agentId),
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
