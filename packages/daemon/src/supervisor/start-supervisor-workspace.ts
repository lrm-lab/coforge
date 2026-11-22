import type { Logger } from "@logtape/logtape";
import { DaemonConfigStore } from "#src/persistence/daemon-config";
import type { WorkspaceProcesses } from "./machine-supervisor";
import { workspaceDaemonConfig } from "./workspace-daemon-config";
import type { WorkspaceAdoptions } from "./workspace-adoption";
import type { WorkspaceInstance } from "./workspace-instance";
import { WorkspaceHealthJournal, workspaceDegradedMessage } from "./workspace-health-journal";
import { throwIfParked, type WorkspaceStartPorts } from "./workspace-start-outcome";
import type {
  WorkspaceRecoveryLaunch,
  WorkspaceUpgradeRecovery,
} from "./workspace-upgrade-recovery";

const WORKSPACE_READINESS_MS = 30_000;

export function startSupervisorWorkspace({
  workspaceDirectory,
  workspaceHealth,
  supervisorLogger,
  workspaceInstance,
  adoptions,
  startPorts,
  upgradeRecovery,
}: {
  workspaceDirectory(id: string): string;
  workspaceHealth(id: string): WorkspaceHealthJournal;
  supervisorLogger: Logger;
  workspaceInstance(id: string): WorkspaceInstance;
  adoptions: WorkspaceAdoptions;
  startPorts: WorkspaceStartPorts;
  upgradeRecovery: WorkspaceUpgradeRecovery;
}): WorkspaceProcesses["start"] {
  return (binding, options = {}) => {
    const directory = workspaceDirectory(binding.workspaceId);
    async function run(recovery?: WorkspaceRecoveryLaunch) {
      // A degraded Workspace must fail fast, not spend up to 30s waiting for local RPC the OS
      // unit will never open: the replacement child would observe the same latch and exit 0
      // (see `guardWorkspaceRunnerStart`). Waiting out that readiness budget delayed every
      // other binding behind it in `#reconcileBindings` (measured ~37s) and, in turn, this
      // Coordinator's own local RPC, until the client-side handshake gave up after 10s with a
      // misleading "did not accept the local handshake" message that hid the real reason.
      // A parked Workspace never gets here: `MachineSupervisor` checks `parkedReason` first.
      const health = await workspaceHealth(binding.workspaceId).state();
      if (health.status === "degraded") {
        const message = workspaceDegradedMessage(health.reason, binding.workspaceId);
        supervisorLogger.error(message, {
          event: "workspace:degraded_start_refused",
          workspace_id: binding.workspaceId,
          reason: health.reason,
          crash_count: health.crashCount,
          degraded_since: health.since,
        });
        throw new Error(message);
      }
      await new DaemonConfigStore(directory).save(workspaceDaemonConfig(binding));
      const instance = workspaceInstance(binding.workspaceId);
      const processId = await instance.ensureStarted(recovery?.beforeLaunch);
      const observed = await instance.identity();
      if (!observed?.active || observed.mainPid !== processId)
        throw new Error("Workspace OS identity changed during startup");
      await recovery?.observeLaunch(observed);
      const identity = adoptions.track(binding, instance, observed);
      // Readiness keeps its own bound whoever asked: an operator command answers by its own
      // deadline while this start finishes behind it, so the instance is still adopted.
      const deadline = Date.now() + WORKSPACE_READINESS_MS;
      try {
        while (Date.now() < deadline) {
          // A stop or configure took over: it stops this unit itself.
          options.signal?.throwIfAborted();
          let reported;
          try {
            reported = await adoptions.handshake(binding.workspaceId, instance, observed);
          } catch (error) {
            await throwIfParked(startPorts, binding.workspaceId);
            throw error;
          }
          if (reported) {
            Object.assign(identity, reported);
            return {
              invocationId: observed.invocationId,
              processId,
              daemonId: reported.instanceId,
            };
          }
          await throwIfParked(startPorts, binding.workspaceId);
          await Bun.sleep(50);
        }
        throw new Error(`Workspace ${binding.workspaceId} failed process readiness`);
      } catch (error) {
        // A failed handshake is not permission to kill an adopted live unit.
        adoptions.forget(binding.workspaceId);
        throw error;
      }
    }
    return upgradeRecovery.start(binding, options.reconciling === true, directory, run);
  };
}
