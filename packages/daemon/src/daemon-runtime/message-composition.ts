import { AGENT_ACTIVITY_DETAIL_KIND, type AgentActivity } from "@lrm/coforge-sdk/internal";
import type { AgentRuntimeConfig } from "@lrm/coforge-anvil";
import type { DaemonConnectionClient } from "#src/connection/daemon-connection-client";
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
import { MentionDeliveryTracker as MentionDeliveries } from "./mention-delivery-tracker";

/** What the runtime supplies to one Agent's message attention, delivery and inbox state. */
export type MessageCompositionPorts = {
  connection: Pick<DaemonConfig, "workspaceId" | "computerId">;
  stateDirectory: string;
  /** The Workspace's current transport, read at send time. */
  transport(): DaemonConnectionClient;
  consumedSeqs: AgentConsumedSeqStore;
  deliveryGate: AgentDeliveryGate;
  runtimeRelease: RuntimeRelease<ActivityLaunch>;
  processManager: AgentProcessManager;
  /** Built after this group: only a delivery marked busy reaches it, so it is read lazily. */
  launchCustody(): Pick<AgentLaunchCustody, "noteTurnStarted" | "ensureInput">;
  activityPublisher: AgentActivityPublisher<ActivityLaunch>;
  currentActivityLaunch(agentId: string): ActivityLaunch | undefined;
  /** One Activity draft, as the runtime builds every other one. */
  activity(
    agentId: string,
    detailKind: AgentActivity["detailKind"],
    level: AgentActivity["level"],
    detail: string,
    extra?: Partial<ActivityDraft>,
  ): ActivityDraft;
  sync: Pick<AgentFeatureSync, "noticePrefix">;
  /** The launch identity a tracked mention's envelope must name, while that launch runs. */
  /** The running process's launch and session, or with `reported` the last ones reported. */
  runningMentionIdentity(agentId: string, reported?: true): RunningMentionIdentity | undefined;
  contexts: AgentContexts;
  /** The Agent's Memory fence, when it is the Memory Agent. */
  memoryAgent(agentId: string): unknown;
  reconcileIdleTurn(agentId: string, launch: ActivityLaunch): boolean;
  /** One launch of a stopped Agent for a held App Inbox item, under the given Session. */
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
  messageAttention: AgentMessageAttentionIndex;
  inboxCoordinator: AgentInboxCoordinator;
  messageOperations: AgentMessageOperations;
};

/**
 * Builds one Workspace runtime's Agent message state: tracked @mention deliveries, per-Agent
 * attention (what was notified, held or consumed), the App Inbox coordination a stopped Agent's
 * item needs, and the Agent's own message operations. `DaemonRuntime` supplies the collaborators
 * those ports call; the group is built in one order because attention and deliveries observe each
 * other, and every such reference is lazy.
 */
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
    // Only an Agent that can still be relaunched has an identity to keep a mention for.
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
    busy: (agentId, conversationId) => {
      const session = ports.processManager.session(agentId);
      return (
        (conversationId ? session?.hasLiveTurnForConversation?.(conversationId) : undefined) ??
        (session?.hasLiveTurn === true || ports.deliveryGate.isBusy(agentId))
      );
    },
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
      } catch {
        // Best-effort observation must not turn accepted input into failed delivery.
      }
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
      // Every change of what the Agent has consumed ends in this write: the mentions it settles.
      consumedSeqs: {
        read: (agentId) => ports.consumedSeqs.read(agentId),
        write: (agentId, state) => {
          ports.consumedSeqs.write(agentId, state);
          mentionDeliveries.settleConsumed(agentId);
        },
      },
      noticePrefix: (agentId) => ports.sync.noticePrefix(agentId),
    },
  );
  // A new context (a launch, or a finished compaction) drops the previews the model no longer
  // holds: those messages read as unread again instead of counting as shown (task #424).
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
  const messageOperations = new MessageOperations({
    connection: { workspaceId: connection.workspaceId, computerId: connection.computerId },
    attention: messageAttention,
    isMemoryAgent: (agentId) => Boolean(ports.memoryAgent(agentId)),
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
  return { mentionDeliveries, messageAttention, inboxCoordinator, messageOperations };
}

/** The wire payload of one Agent-message rejection report: the delivery's identity fields plus
 * the reason, under the reject method the server recognizes. */
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
