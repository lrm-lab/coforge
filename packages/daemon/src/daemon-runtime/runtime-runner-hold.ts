import type { ActivityLaunch } from "./activity-launch";
import type { AgentActivityPublisher, BusyAgentReport } from "./agent-activity-publisher";
import type { AgentInputDrain } from "./agent-input-drain";
import type { MentionDeliveryTracker } from "./mention-delivery-tracker";
import type { RunnerHold } from "./shutdown-reason";
import type { RunnerHoldReason } from "@lrm/coforge-sdk/internal";
import type { AgentProcessManager } from "#src/agent-runtime/agent-process-manager";
import { MENTION_DELIVERY_TERMINAL_CODES } from "@lrm/coforge-sdk/internal";
import { getLogger } from "@logtape/logtape";

const logger = getLogger(["coforge", "daemon", "runtime"]);

type HoldState = {
  get hold(): RunnerHold | undefined;
  set hold(value: RunnerHold | undefined);
};

/** Stops admitting new Agent turns and reports which Agents are still busy. Idempotent: a repeat
 * call only re-reads the busy set, which is what the restart's quiescence poll relies on. */
export function holdRunners(
  state: HoldState,
  reason: RunnerHoldReason,
  activityPublisher: AgentActivityPublisher<ActivityLaunch>,
): BusyAgentReport[] {
  if (state.hold === undefined)
    logger.info("Runner hold engaged", { event: "daemon.runner_hold.engaged", reason });
  state.hold = { reason, renewedAtMs: Date.now() };
  return activityPublisher.busyAgents();
}

export function releaseRunners(
  state: HoldState,
  activityPublisher: AgentActivityPublisher<ActivityLaunch>,
  inputDrain: AgentInputDrain,
  processManager: AgentProcessManager,
  agentLaunches: Map<string, Promise<unknown>>,
  mentionDeliveries: MentionDeliveryTracker,
): BusyAgentReport[] {
  if (state.hold !== undefined)
    logger.info("Runner hold released", {
      event: "daemon.runner_hold.released",
      reason: state.hold.reason,
    });
  state.hold = undefined;
  // A mention a runner hold kept queued for an Agent with no session and no launch in flight names
  // a launch that is gone: it is settled now rather than left queued.
  for (const [agentId] of inputDrain.entries()) {
    if (processManager.session(agentId) || agentLaunches.has(agentId)) continue;
    inputDrain.dropDeliveries(agentId, (message) =>
      mentionDeliveries.drop(message, MENTION_DELIVERY_TERMINAL_CODES.IDENTITY_UNKNOWN),
    );
  }
  // Copied deliberately: a finishing drain deletes its own entry mid-iteration.
  const queued = [...inputDrain.entries()].map(([agentId]) => agentId);
  for (const agentId of queued) inputDrain.ensure(agentId);
  return activityPublisher.busyAgents();
}
