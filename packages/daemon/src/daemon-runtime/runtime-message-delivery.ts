import {
  MENTION_DELIVERY_TERMINAL_CODES,
  WORKSPACE_PROTOCOL_MAJOR,
  type AgentMessageDelivery,
} from "@lrm/coforge-sdk/internal";
import type { AgentProcessManager, AgentRuntime } from "#src/agent-runtime/agent-process-manager";
import type { AgentDeliveryQueue } from "./agent-delivery-queue";
import type { AgentExitedDelivery } from "./agent-exited-delivery";
import type { AgentFeatureSync } from "./agent-feature-sync";
import type { AgentInputDrain } from "./agent-input-drain";
import type { AgentLaunchCustody } from "./agent-launch-custody";
import type { ActivityLaunch } from "./activity-launch";
import type { MentionDeliveryTracker, TrackedMentionDelivery } from "./mention-delivery-tracker";
import type { RuntimeRelease } from "./runtime-release";
import { isTrackedMention } from "./mention-delivery-tracker";
import { getLogger } from "@logtape/logtape";

const logger = getLogger(["coforge", "daemon", "runtime"]);

export type RuntimeMessageDeliveryPorts = {
  assertRunning(): void;
  workspaceId: string;
  stoppingAgents: Set<string>;
  runnerHold: { reason: string } | undefined;
  runtimeRelease: RuntimeRelease<ActivityLaunch>;
  sync: AgentFeatureSync;
  exitedDelivery: AgentExitedDelivery;
  wakeLaunches: Set<string>;
  agentLaunches: Map<string, Promise<AgentRuntime>>;
  deliveryQueue: AgentDeliveryQueue;
  launchCustody: AgentLaunchCustody;
  inputDrain: AgentInputDrain;
  agentProcessManager: AgentProcessManager;
  mentionDeliveries: MentionDeliveryTracker;
};

export async function handleAgentMessage(
  ports: RuntimeMessageDeliveryPorts,
  message: AgentMessageDelivery,
): Promise<void> {
  ports.assertRunning();
  if (message.protocolMajor !== WORKSPACE_PROTOCOL_MAJOR)
    throw new Error("unsupported agent protocol major");
  if (message.workspaceId !== ports.workspaceId)
    throw new Error("agent message targets another Workspace");
  if (isTrackedMention(message)) return handleTrackedMention(ports, message);
  if (ports.stoppingAgents.has(message.agentId))
    throw new Error(`Agent runtime is stopping: ${message.agentId}`);
  if (ports.runnerHold === undefined) {
    // A stalled provider is restarted for this message; arrivals meanwhile wait for that relaunch.
    const recovering = ports.runtimeRelease.isRecovering(message.agentId);
    const stalled = recovering ? undefined : ports.runtimeRelease.stalled(message.agentId);
    if (recovering || stalled) {
      ports.exitedDelivery.keepForNextLaunch(message.agentId, message);
      if (stalled) return ports.runtimeRelease.recoverStalled(message.agentId, stalled);
      return;
    }
  }
  if (ports.runnerHold === undefined && ports.sync.changed(message))
    return ports.sync.restart(message);
  const exited =
    ports.runnerHold === undefined &&
    !ports.agentProcessManager.session(message.agentId) &&
    !ports.agentLaunches.has(message.agentId);
  if (exited) return ports.exitedDelivery.deliver(message);
  if (
    ports.runnerHold === undefined &&
    !ports.agentProcessManager.session(message.agentId) &&
    ports.wakeLaunches.has(message.agentId) &&
    ports.deliveryQueue.hasQueued(message.agentId)
  ) {
    // A wake launch that will present waiting deliveries is still in flight: join them as well,
    // rather than arriving as a second notice right after theirs. Only a wake: a recovery launch
    // drops what waits once its own notice is accepted, and that notice does not cover this one.
    ports.exitedDelivery.keepForNextLaunch(message.agentId, message);
    return;
  }
  const delivery = ports.launchCustody.enqueueDelivery(message.agentId, message);
  // Runner hold: the delivery is queued, never rejected and never indexed. Attention indexing is
  // what wakes a turn, and the server's canonical read boundary only advances when the Agent
  // itself drains `check` - so a held delivery stays undelivered server-side and is re-fetched
  // after the restart. Nothing is acknowledged while the hold is in force.
  if (ports.runnerHold !== undefined) {
    void delivery.catch(() => {});
    logger.info("Agent delivery queued behind a runner hold", {
      event: "agent.message.delivery_held",
      agent_id: message.agentId,
      delivery_id: message.deliveryId,
      reason: ports.runnerHold.reason,
    });
    return;
  }
  if (ports.agentProcessManager.session(message.agentId)) ports.inputDrain.ensure(message.agentId);
  // Otherwise a launch is in flight, and it drains the queue once its session is up.
  return delivery;
}

/**
 * A tracked @mention: told only to the running launch and session its envelope names, and ACKed
 * only once drained there (`MentionDeliveryTracker`). It never wakes an Agent, waits for a
 * launch or a pending server Start, or becomes `no_process`: with no running session it is
 * drained if already consumed and refused as `IDENTITY_UNKNOWN` otherwise, and the server
 * decides what happens next. A runner hold queues it unacknowledged like any delivery.
 */
export function handleTrackedMention(
  ports: RuntimeMessageDeliveryPorts,
  message: TrackedMentionDelivery,
): Promise<void> {
  const { agentId } = message;
  const refusal = ports.mentionDeliveries.admissionRefusal(message);
  if (refusal) return ports.mentionDeliveries.refuse(message, refusal);
  if (
    ports.runnerHold === undefined &&
    (ports.stoppingAgents.has(agentId) ||
      ports.runtimeRelease.isRecovering(agentId) ||
      !ports.agentProcessManager.session(agentId))
  ) {
    // A stalled provider being restarted is no session to tell: refused as unknown, the server
    // keeps the mention pending and issues it again for the relaunch's session report.
    ports.mentionDeliveries.drop(message, MENTION_DELIVERY_TERMINAL_CODES.IDENTITY_UNKNOWN);
    return Promise.resolve();
  }
  const delivery = ports.launchCustody.enqueueDelivery(agentId, message);
  if (ports.runnerHold !== undefined) {
    void delivery.catch(() => {});
    return Promise.resolve();
  }
  ports.inputDrain.ensure(agentId);
  return delivery;
}
