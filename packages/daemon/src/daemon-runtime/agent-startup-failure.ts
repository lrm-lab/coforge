import { AGENT_STARTUP_TIMEOUT_MS } from "#src/agent-runtime/agent-startup";
import type { AgentControl } from "#src/agent-runtime/agent-control";
import type { AgentInputDrain } from "./agent-input-drain";
import type { AgentStopCoordinator } from "./agent-stop-coordinator";
import type { AgentActivityPublisher } from "./agent-activity-publisher";
import type { AgentOfflineResidency } from "./agent-offline-residency";
import type { ActivityLaunch } from "./activity-launch";
import { agentActivityDrafts } from "./agent-activity-drafts";
import { diagnosticErrorCode } from "@lrm/coforge-sdk/internal";
import { getLogger } from "@logtape/logtape";

type AgentActivityDrafts = ReturnType<typeof agentActivityDrafts>;

const logger = getLogger(["coforge", "daemon", "runtime"]);

type Ports = {
  stopping: boolean;
  stoppingAgents: Set<string>;
  inputDrain: AgentInputDrain;
  currentActivityLaunches: Map<string, ActivityLaunch>;
  interruptIfBusy(agentId: string, launch: ActivityLaunch | undefined): void;
  activityPublisher: AgentActivityPublisher<ActivityLaunch>;
  disposeLaunchObservations(agentId: string): void;
  revokeLocalLaunch(agentId: string): void;
  offlineResidency: AgentOfflineResidency;
  stopCoordinator: AgentStopCoordinator;
  agentStops: Map<string, Promise<void>>;
  drafts: AgentActivityDrafts;
  agentControl: AgentControl;
};

export async function abandonLaunch(
  ports: Ports,
  agentId: string,
  error: unknown,
): Promise<unknown> {
  ports.stoppingAgents.add(agentId);
  ports.inputDrain.close(agentId, error);
  const activityLaunch = ports.currentActivityLaunches.get(agentId);
  activityLaunch?.startup?.dispose();
  if (activityLaunch) activityLaunch.stopping = true;
  ports.interruptIfBusy(agentId, activityLaunch);
  ports.activityPublisher.forgetBusy(agentId);
  ports.disposeLaunchObservations(agentId);
  ports.revokeLocalLaunch(agentId);
  const offlineError = ports.offlineResidency.record(agentId);
  try {
    await ports.stopCoordinator.releaseAgentRuntime(agentId);
    if (offlineError) ports.offlineResidency.remember(agentId, offlineError);
    if (!ports.agentStops.has(agentId)) ports.stoppingAgents.delete(agentId);
    return error;
  } catch (cleanupError) {
    return cleanupError;
  }
}

export async function failAgentStartup(
  ports: Ports,
  agentId: string,
  launch: ActivityLaunch,
): Promise<void> {
  if (ports.stopping || launch.stopping || ports.currentActivityLaunches.get(agentId) !== launch)
    return;
  const detail = `Agent runtime did not become ready within ${AGENT_STARTUP_TIMEOUT_MS / 1000} seconds. Check the provider on this Computer, then start the Agent again.`;
  const error = new Error(detail);
  if (!launch.startup?.fail(error)) return;
  logger.warning("Agent runtime startup failed", {
    event: "agent_runtime:startup_timed_out",
    agent_id: agentId,
    launch_id: launch.launchId,
    timeout_ms: AGENT_STARTUP_TIMEOUT_MS,
    outcome: "failed",
  });
  ports.activityPublisher.publish(agentId, launch, ports.drafts.runtimeError(agentId, detail));
  const outcome = await abandonLaunch(ports, agentId, error);
  if (outcome !== error) throw outcome;
  await ports.agentControl.stopped(agentId, launch.launchId);
}

export function scheduleStartupFailure(
  ports: Ports,
  agentId: string,
  launch: ActivityLaunch,
): void {
  void failAgentStartup(ports, agentId, launch).catch((error: unknown) => {
    logger.error("Agent startup cleanup did not confirm process exit", {
      event: "agent_runtime:startup_cleanup_failed",
      agent_id: agentId,
      error_code: diagnosticErrorCode(error),
    });
  });
}
