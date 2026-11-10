import { AGENT_STARTUP_TIMEOUT_MS } from "#src/agent-runtime/agent-startup";
import { launchFailureLogFields } from "#src/agent-runtime/launch-failure";
import type { AgentRuntimeConfig } from "@lrm/coforge-anvil";
import type { AgentStopRegistry } from "./agent-stop-registry";
import type { AgentControl } from "#src/agent-runtime/agent-control";
import type { AgentInputDrain } from "./agent-input-drain";
import type { AgentStopCoordinator } from "./agent-stop-coordinator";
import type { AgentActivityPublisher } from "./agent-activity-publisher";
import type { AgentOfflineResidency, OfflineResidencyLaunch } from "./agent-offline-residency";
import type { ActivityLaunch } from "./activity-launch";
import type { AgentLaunchCoordinatorPorts } from "./agent-launch-coordinator";
import { agentActivityDrafts } from "./agent-activity-drafts";
import { runtimeDisplayName } from "./session-invalidate-activity";
import { diagnosticErrorCode } from "@lrm/coforge-sdk/internal";
import { getLogger } from "@logtape/logtape";

type AgentActivityDrafts = ReturnType<typeof agentActivityDrafts>;

const logger = getLogger(["coforge", "daemon", "runtime"]);

type Ports = {
  stopping: boolean;
  /** Which Agents are stopping: a failed startup joins that state. */
  stops: Pick<AgentStopRegistry, "markStopping" | "pendingStop" | "forgetStopping">;
  inputDrain: Pick<AgentInputDrain, "close">;
  currentActivityLaunches: Map<string, ActivityLaunch>;
  interruptIfBusy(agentId: string, launch: ActivityLaunch | undefined): void;
  activityPublisher: Pick<AgentActivityPublisher<ActivityLaunch>, "forgetBusy" | "publish">;
  disposeLaunchObservations(agentId: string): void;
  revokeLocalLaunch(agentId: string): void;
  offlineResidency: Pick<AgentOfflineResidency, "record" | "remember">;
  stopCoordinator: Pick<AgentStopCoordinator, "releaseAgentRuntime">;
  drafts: Pick<AgentActivityDrafts, "runtimeError">;
  agentControl: Pick<AgentControl, "stopped">;
};

export async function abandonLaunch(
  ports: Ports,
  agentId: string,
  error: unknown,
): Promise<unknown> {
  ports.stops.markStopping(agentId);
  ports.inputDrain.close(agentId, error);
  const activityLaunch = ports.currentActivityLaunches.get(agentId);
  // The other producer of `Turn stopped` (a turn interrupt is the first): without this line a
  // teardown the daemon started is indistinguishable from a stop the server asked for (task #630).
  logger.info("Agent launch abandoned", {
    event: "agent:launch_abandoned",
    agent_id: agentId,
    ...(activityLaunch ? { launch_id: activityLaunch.launchId } : {}),
    error_code: diagnosticErrorCode(error),
    outcome: "abandoned",
  });
  activityLaunch?.startup?.dispose();
  if (activityLaunch) activityLaunch.stopping = true;
  ports.interruptIfBusy(agentId, activityLaunch);
  ports.activityPublisher.forgetBusy(agentId);
  ports.disposeLaunchObservations(agentId);
  ports.revokeLocalLaunch(agentId);
  // An abandoned launch is teardown, not a person's Stop: an offline error's record must
  // survive so later deliveries still restate the failure that took the Agent down.
  const offlineError = ports.offlineResidency.record(agentId);
  try {
    await ports.stopCoordinator.releaseAgentRuntime(agentId);
    if (offlineError) ports.offlineResidency.remember(agentId, offlineError);
    return error;
  } catch (cleanupError) {
    return cleanupError;
  } finally {
    // The launch gate re-opens however the teardown ended; a stuck mark would mute the Agent's
    // Activity and refuse every later launch.
    if (!ports.stops.pendingStop(agentId)) ports.stops.forgetStopping(agentId);
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

/** What a launch that threw owes the Agent: the failure log, the offline record or quota wait
 * a thrown open classifies to, `inactive` unless a recovery time stands, and the Activity —
 * the failure's own wording when it wrote an offline record, the launcher wording otherwise.
 * An offline record also drops the Agent's wake config, so no delivery or App Inbox notice
 * can launch it again until a person's Start succeeds; a quota wait keeps the config — its
 * cooldown, not custody, governs the next launch. */
export function reportLaunchFailure(
  ports: AgentLaunchCoordinatorPorts,
  agentId: string,
  launch: OfflineResidencyLaunch,
  config: Pick<AgentRuntimeConfig, "provider" | "model" | "providerConfig">,
  error: unknown,
): void {
  if (ports.isStopping() || ports.stops.stopping(agentId)) return;
  // The Activity sends people to the Computer log for the cause; this is that line.
  logger.warning("Agent launch failed", {
    event: "agent_runtime:launch_failed",
    agent_id: agentId,
    provider: config.provider,
    launch_id: launch.launchId,
    ...launchFailureLogFields(error),
    outcome: "failed",
  });
  // A thrown open whose text names a recovery time records a wait (`hasLaunchWait`) and
  // must not report inactive. An offline classification keeps that failure's Activity
  // instead of the generic launcher wording. The log above stays the typed launch reason.
  const offlineLaunchError =
    launch.offlineError ??
    ports.offlineResidency.thrownLaunchActivity(
      agentId,
      launch,
      runtimeDisplayName(config.provider),
      config,
      error,
    );
  if (offlineLaunchError && ports.offlineResidency.has(agentId))
    ports.agentProcessManager.forgetRestart(agentId);
  if (!ports.offlineResidency.hasLaunchWait(agentId)) ports.sendAgentStatus(agentId, "inactive");
  ports.activityPublisher.publish(
    agentId,
    launch,
    offlineLaunchError
      ? ports.activity(
          agentId,
          offlineLaunchError.detailKind,
          offlineLaunchError.level,
          offlineLaunchError.detail,
          {
            entries: offlineLaunchError.entries,
            runtimeError: offlineLaunchError.runtimeError,
          },
        )
      : ports.launchFailureActivity(agentId, config.provider, error),
  );
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
