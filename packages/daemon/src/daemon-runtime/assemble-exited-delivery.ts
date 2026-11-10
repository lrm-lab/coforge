import type {
  AgentRestartConfig,
  AgentProcessManager,
} from "#src/agent-runtime/agent-process-manager";
import type { AgentControl } from "#src/agent-runtime/agent-control";
import type { LaunchFailureBackoff } from "#src/agent-runtime/launch-failure-backoff";
import type { AgentMessageDelivery } from "@lrm/coforge-sdk/internal";
import { MENTION_DELIVERY_TERMINAL_CODES } from "@lrm/coforge-sdk/internal";
import type { DaemonConnectionClient } from "#src/connection/daemon-connection-client";
import { logAgentOperationFailure } from "./agent-failure-logs";
import { AgentExitedDelivery } from "./agent-exited-delivery";
import type { AgentDeliveryGate } from "./agent-delivery-gate";
import type { AgentInputDrain } from "./agent-input-drain";
import type { AgentLaunchCustody } from "./agent-launch-custody";
import type { AgentMessageAttentionIndex } from "./agent-message-attention-index";
import type { AgentOfflineResidency } from "./agent-offline-residency";
import { agentDeliveryRejection } from "./message-composition";
import { isTrackedMention, type MentionDeliveryTracker } from "./mention-delivery-tracker";

/** What the exited-delivery settlement reads from the runtime. The collaborators the runtime builds
 * after this one are thunks: they are read when a delivery is settled, not when this is made. */
export type ExitedDeliveryCollaborators = {
  deliveryGate: AgentDeliveryGate;
  wakeLaunchFailures: LaunchFailureBackoff;
  sendAgentStatus(agentId: string, status: "active" | "inactive"): void;
  messageAttention(): AgentMessageAttentionIndex;
  launchCustody(): AgentLaunchCustody;
  agentProcessManager(): AgentProcessManager;
  agentControl(): AgentControl;
  offlineResidency(): AgentOfflineResidency;
  inputDrain(): AgentInputDrain;
  mentionDeliveries(): MentionDeliveryTracker;
  transport(): DaemonConnectionClient;
  computerId(): string;
  wakeAgent(agentId: string, restart: AgentRestartConfig): Promise<unknown>;
  handleAgentMessage(message: AgentMessageDelivery): Promise<void>;
};

/** Settles a delivery for an Agent with no hold, session or launch in flight (`AgentExitedDelivery`). */
export function assembleExitedDelivery(ports: ExitedDeliveryCollaborators): AgentExitedDelivery {
  return new AgentExitedDelivery({
    hasRuntimeErrorHold: (agentId) => ports.deliveryGate.explicitHold(agentId) !== undefined,
    holdRuntimeErrorDelivery: (message) => ports.messageAttention().receive(message),
    hasConsumed: (message) => ports.messageAttention().hasConsumed(message),
    logConsumed: (message) => ports.messageAttention().logDecision(message, "consumed"),
    acknowledge: (message) => ports.messageAttention().acknowledge(message),
    acknowledgeCustody: (message) => ports.launchCustody().acknowledge(message),
    restartConfig: (agentId) => ports.agentProcessManager().restartConfig(agentId),
    startPending: (agentId) => ports.agentControl().startPending(agentId),
    hasQueued: (agentId) => ports.deliveryGate.hasQueued(agentId),
    queueForNextLaunch: (agentId, m) => ports.deliveryGate.enqueue(agentId, m),
    wakeBlockedUntil: (agentId) =>
      ports.wakeLaunchFailures.isBlocked(agentId)
        ? ports.wakeLaunchFailures.blockedUntil(agentId)
        : undefined,
    whenCancelled: (agentId, hook) => ports.mentionDeliveries().whenCancelled(agentId, hook),
    enqueueInputDelivery: (agentId, message) =>
      ports.launchCustody().enqueueDelivery(agentId, message),
    wakeAgent: (agentId, restart) => ports.wakeAgent(agentId, restart),
    offline: {
      has: (agentId) => ports.offlineResidency().has(agentId),
      restate: (agentId) => ports.offlineResidency().restate(agentId),
    },
    queuedInputDeliveries: (agentId) => ports.inputDrain().queuedDeliveries(agentId),
    drainInputDeliveries: (agentId) => ports.inputDrain().drainDeliveries(agentId),
    closeAgentInputQueue: (agentId, error) => ports.inputDrain().close(agentId, error),
    dropMentionAsUnknown: (message) =>
      ports.mentionDeliveries().drop(message, MENTION_DELIVERY_TERMINAL_CODES.IDENTITY_UNKNOWN),
    keepMention: (message) =>
      isTrackedMention(message) && ports.mentionDeliveries().carry.hold(message),
    hasKeptMentions: (agentId) => ports.mentionDeliveries().carry.hasCarried(agentId),
    refuseKeptMentions: (agentId, code) =>
      ports.mentionDeliveries().carry.refuseCarried(agentId, code),
    holdMention: (message) => {
      if (!isTrackedMention(message)) return false;
      ports.mentionDeliveries().carry.hold(message, true);
      return true;
    },
    sendAgentStatus: ports.sendAgentStatus,
    sendAgentDeliveryRejection: (message, reason) =>
      ports.transport().sendAgentDeliveryRejection?.(agentDeliveryRejection(message, reason)) ??
      Promise.resolve(),
    hasSession: (agentId) => ports.agentProcessManager().session(agentId) !== undefined,
    redeliver: (message) =>
      void ports
        .handleAgentMessage(message)
        .catch((error) =>
          logAgentOperationFailure(ports.computerId(), "message_delivery", message, error),
        ),
  });
}
