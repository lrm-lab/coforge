import { getLogger } from "@logtape/logtape";
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
import { waitsOnProvider, type AgentDeliveryGate } from "./agent-delivery-gate";
import type { AgentInputDrain } from "./agent-input-drain";
import type { AgentLaunchCustody } from "./agent-launch-custody";
import type { AgentMessageAttentionIndex } from "./agent-message-attention-index";
import type { AgentOfflineResidency } from "./agent-offline-residency";
import { agentDeliveryRejection } from "./message-composition";
import { WAKE_FAILURE_STREAK_CAP } from "./wake-launch";
import { isTrackedMention, type MentionDeliveryTracker } from "./mention-delivery-tracker";

const logger = getLogger(["coforge", "daemon", "runtime"]);

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
  const exited = new AgentExitedDelivery({
    hasRuntimeErrorHold: (agentId) => ports.deliveryGate.explicitHold(agentId) !== undefined,
    providerHeld: (agentId) => waitsOnProvider(ports.deliveryGate.explicitHold(agentId)),
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
    giveUpWake: (agentId) => {
      if (!ports.wakeLaunchFailures.exhausted(agentId, WAKE_FAILURE_STREAK_CAP)) return;
      // No launch is coming: with the wake config gone a later delivery is rejected `no_process`
      // and the server decides whether to start the Agent.
      logger.warning("Agent wake given up after repeated launch failures", {
        event: "agent.wake.given_up",
        agent_id: agentId,
        attempts: ports.wakeLaunchFailures.attempts(agentId),
      });
      ports.wakeLaunchFailures.reset(agentId);
      ports.agentProcessManager().forgetRestart(agentId);
      exited.refuseKept(agentId, MENTION_DELIVERY_TERMINAL_CODES.IDENTITY_UNKNOWN);
    },
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
    refuseMention: (message, code) => void ports.mentionDeliveries().refuse(message, code),
    refuseKeptMention: (message, code) =>
      ports.mentionDeliveries().carry.refuseKeptOne(message, code),
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
    launchComing: (agentId) =>
      ports.agentProcessManager().session(agentId) !== undefined ||
      ports.inputDrain().isLaunching(agentId) ||
      ports.agentControl().startPending(agentId),
    redeliver: (message) =>
      void ports
        .handleAgentMessage(message)
        .catch((error) =>
          logAgentOperationFailure(ports.computerId(), "message_delivery", message, error),
        ),
  });
  // Every failed wake, whoever started it, leaves the mentions still kept to the cooldown wake.
  ports.wakeLaunchFailures.onFailure((agentId) => exited.wakeFailed(agentId));
  return exited;
}
