import type { ActivityLaunch } from "./activity-launch";
import type { AgentActivityPublisher, BusyAgentReport } from "./agent-activity-publisher";
import type { AgentInputDrain } from "./agent-input-drain";
import type { MentionDeliveryTracker } from "./mention-delivery-tracker";
import type { RunnerHold } from "./shutdown-reason";
import type { RunnerHoldReason } from "@lrm/coforge-sdk/internal";
import type { AgentProcessManager } from "#src/agent-runtime/agent-process-manager";
import { dropHeldMentionsWithoutSession } from "./held-mention-sweep";
import { MENTION_DELIVERY_TERMINAL_CODES } from "@lrm/coforge-sdk/internal";
import { getLogger } from "@logtape/logtape";

const logger = getLogger(["coforge", "daemon", "runtime"]);

type HoldState = {
  get hold(): RunnerHold | undefined;
  set hold(value: RunnerHold | undefined);
};

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
  dropHeldMentionsWithoutSession({
    inputDrain,
    hasSession: (agentId) => Boolean(processManager.session(agentId)),
    hasLaunch: (agentId) => agentLaunches.has(agentId),
    dropMention: (message) =>
      mentionDeliveries.drop(message, MENTION_DELIVERY_TERMINAL_CODES.IDENTITY_UNKNOWN),
  });
  // Copied deliberately: a finishing drain deletes its own entry mid-iteration.
  const queued = [...inputDrain.entries()].map(([agentId]) => agentId);
  for (const agentId of queued) inputDrain.ensure(agentId);
  return activityPublisher.busyAgents();
}
