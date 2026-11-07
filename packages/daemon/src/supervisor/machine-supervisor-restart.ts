import { getLogger } from "@logtape/logtape";
import { RUNNER_HOLD_REASONS } from "@lrm/coforge-sdk/internal";
import { holdRunnersUntilQuiescent } from "./runner-hold";
import { appendRestartResult } from "./machine-supervisor-bindings";
import type { ManagedBinding, RestartHoldTuning, WorkspaceProcesses } from "./machine-supervisor";

const logger = getLogger(["coforge", "daemon", "supervisor"]);

/**
 * The restart progression's view of this Coordinator: the Workspace process seam plus the
 * serialized stop/start/save steps it composes. `MachineSupervisor` supplies the context; the
 * functions run inside its mutation queue.
 */
export type MachineRestartContext = {
  processes: WorkspaceProcesses;
  restartHold: RestartHoldTuning;
  stop(binding: ManagedBinding): Promise<void>;
  start(binding: ManagedBinding, signal?: AbortSignal): Promise<string>;
  saveBinding(binding: ManagedBinding): Promise<ManagedBinding>;
};

export async function advanceWorkspaceRestart(
  context: MachineRestartContext,
  binding: ManagedBinding,
  signal?: AbortSignal,
): Promise<void> {
  const restart = binding.restart!;
  if (restart.phase === "stopping") {
    const current = await context.processes.instance(binding);
    // The same stable OS unit may already have replaced its failed invocation.
    // start below still validates the replacement through its scoped handshake.
    if (current === null || current === restart.previousInstanceId) {
      // Only a live instance is worth holding; a dead one has no Agents left to drain.
      if (current !== null) await holdRunnersForRestart(context, binding, signal);
      // A stop or configure took over while the Agents drained: it stops the daemon itself.
      signal?.throwIfAborted();
      try {
        await context.stop(binding);
      } catch (error) {
        // The daemon we meant to kill is still up and still held: lift the hold before
        // surfacing the failure, or its Agents would queue turns until someone retries.
        if (current !== null)
          await context.processes
            .release?.(binding, RUNNER_HOLD_REASONS.WORKSPACE_RESTART)
            .catch(() => {});
        throw error;
      }
    }
    binding = await context.saveBinding({
      ...binding,
      restart: { ...restart, phase: "starting" },
    });
  }
  const instanceId = await context.start(binding, signal);
  if (instanceId === restart.previousInstanceId)
    throw new Error("Workspace restart did not replace the old instance");
  await context.saveBinding({
    ...binding,
    restart: undefined,
    restartResults: appendRestartResult(binding, {
      requestId: restart.requestId,
      status: "completed",
      instanceId,
    }),
  });
}

/**
 * Bounded runner hold before a restart stops a live Workspace daemon. Without it
 * `context.stop` hands the Agents the ~2s SIGTERM/SIGKILL ladder in `DaemonRuntime.stop()`,
 * which is not enough for a tool call. Only `restart` holds: `stop` is an operator saying "now".
 *
 * Nothing releases the hold afterwards, and nothing needs to. It is in-memory in the Workspace
 * daemon and `context.stop` kills that process; the replacement is born without a hold
 * (the hold is never persisted). The one exception is a stop that fails: the daemon survives
 * held, so `advanceWorkspaceRestart` releases it before rethrowing; a later retry re-asks, which
 * is idempotent.
 *
 * The wait runs inside the serialized mutation, so other lifecycle commands queue behind it for
 * up to `RUNNER_HOLD_MS`. That is accepted: a restart that raced ahead of the drain would defeat
 * the point. An operator restart keeps the full bound too: its answer is bounded by its deadline
 * (`#answerBy`), not by cutting the drain short for Agents mid tool call.
 *
 * Every failure resolves towards proceeding: `holdRunnersUntilQuiescent` reports quiescent when
 * the hold cannot be asked at all, and a Workspace that answers `accepted: false` or times out
 * is counted as idle. A restart is never failed because of the hold.
 */
async function holdRunnersForRestart(
  context: MachineRestartContext,
  binding: ManagedBinding,
  signal?: AbortSignal,
): Promise<void> {
  if (!context.processes.hold) return;
  const outcome = await holdRunnersUntilQuiescent({
    hold: () => context.processes.hold!(binding, RUNNER_HOLD_REASONS.WORKSPACE_RESTART),
    ...context.restartHold,
    ...(signal ? { signal } : {}),
  });
  logger.info("Runner hold completed before a Workspace restart", {
    event: outcome.quiescent ? "restart:runner_hold_quiescent" : "restart:runner_hold_expired",
    workspace_id: binding.workspaceId,
    quiescent: outcome.quiescent,
    elapsed_ms: outcome.elapsedMs,
    busy_agent_count: outcome.busyAgents.length,
    unreachable_workspace_ids: outcome.unreachableWorkspaceIds,
  });
}
