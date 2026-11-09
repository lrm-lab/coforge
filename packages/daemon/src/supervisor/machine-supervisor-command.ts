import type {
  CommandAnswer,
  CommandOptions,
  CommandProgress,
  ManagedBinding,
  WorkspaceProcesses,
} from "./machine-supervisor-contracts";
import type { LifecycleFailure } from "./machine-supervisor-operations";
import { WorkspaceParkedError } from "./workspace-health-journal";
import { WorkspaceLifecycleSupersededError } from "./lifecycle-superseded-error";
import { appendRestartResult, stopped, workspaceIdOf } from "./machine-supervisor-bindings";

/** What one lifecycle command needs from its supervisor: the process seams under each binding and
 * the mutation primitives it may call. The supervisor builds it per call, so the command runs
 * outside the class without reaching into its private state. */
export interface MachineCommandContext {
  readonly processes: WorkspaceProcesses;
  refresh(): Promise<void>;
  bindings(): readonly ManagedBinding[];
  targets(operation: "start" | "stop" | "restart", workspaceId?: string): ManagedBinding[];
  saveBinding(binding: ManagedBinding): Promise<ManagedBinding>;
  stop(binding: ManagedBinding): Promise<void>;
  clearFailure(workspaceId: string): Promise<void>;
  supersededBy(workspaceId: string): { sequence: number; by: "stop" | "configure" } | undefined;
  track<T>(workspaceId: string, run: (signal: AbortSignal) => Promise<T>): Promise<T>;
  advanceRestart(binding: ManagedBinding, signal?: AbortSignal): Promise<void>;
  start(binding: ManagedBinding, signal?: AbortSignal): Promise<string>;
  supersede(workspaceIds: readonly string[], by: "stop" | "configure"): number;
  nextSequence(): number;
  markUnderWay(workspaceIds: readonly string[]): {
    one(workspaceId: string): void;
    all(): void;
  };
  persistStopIntent(workspaceIds: readonly string[], sequence: number): Promise<void>;
  releaseStopIntents(workspaceIds: readonly string[], sequence: number): void;
  recordFailureAfterAnswer(
    operation: LifecycleFailure["operation"],
    workspaceIds: readonly string[],
    error: unknown,
  ): void;
  serialize<T>(operation: () => Promise<T>): Promise<T>;
  answerBy<T>(
    deadline: number,
    work: Promise<T>,
    early: () => T,
    late: (error: unknown) => void,
  ): Promise<T>;
}

export async function runWorkspaceCommand(
  context: MachineCommandContext,
  operation: "start" | "stop" | "restart",
  workspaceId: string | undefined,
  requestId: string | undefined,
  sequence: number,
  progress: CommandProgress,
): Promise<CommandAnswer> {
  await context.refresh();
  if (workspaceId && !context.bindings().some((binding) => binding.workspaceId === workspaceId))
    throw new Error("Workspace is not registered locally");
  const targets = context.targets(operation, workspaceId);
  progress.targets = targets.map((binding) => binding.workspaceId);
  for (let binding of targets) {
    const id = binding.workspaceId;
    if (operation === "stop") {
      binding = await context.saveBinding(stopped(binding));
      await context.stop(binding);
      await context.clearFailure(id);
    } else {
      // The other targets still start; the refusal names the parked one once they have.
      const reason = await context.processes.parkedReason?.(binding);
      if (reason) {
        // A parked binding the operator stopped stays out of an unscoped start.
        if (workspaceId || binding.enabled)
          progress.refused ??= new WorkspaceParkedError(id, reason);
      } else if ((context.supersededBy(id)?.sequence ?? 0) > sequence) {
        // A stop or configure requested after this command takes precedence.
        const { by } = context.supersededBy(id)!;
        progress.superseded ??= new WorkspaceLifecycleSupersededError(id, by, operation);
        // Record it like one taken over while running, so a replay neither runs nor re-enables.
        if (
          operation === "restart" &&
          requestId &&
          binding.restart?.requestId !== requestId &&
          !binding.restartResults?.some((entry) => entry.requestId === requestId)
        )
          await context.saveBinding({
            ...binding,
            restartResults: appendRestartResult(binding, {
              requestId,
              status: "cancelled",
              by,
            }),
          });
      } else {
        try {
          const current = binding;
          if (
            await context.track(id, (signal) =>
              startForOperator(context, operation, current, requestId, signal),
            )
          )
            progress.started.push(id);
          await context.clearFailure(id);
        } catch (error) {
          // It parked as it started (the cloud refused it at once): the rest still start.
          if (error instanceof WorkspaceParkedError) progress.refused ??= error;
          else if (error instanceof WorkspaceLifecycleSupersededError)
            progress.superseded ??= new WorkspaceLifecycleSupersededError(id, error.by, operation);
          else throw error;
        }
      }
    }
    progress.done += 1;
    progress.settle(id);
  }
  if (progress.refused) throw progress.refused;
  if (progress.superseded) throw progress.superseded;
  return { started: progress.started, pending: [] };
}

async function startForOperator(
  context: MachineCommandContext,
  operation: "start" | "restart",
  binding: ManagedBinding,
  requestId: string | undefined,
  signal: AbortSignal,
): Promise<boolean> {
  // Reached only for "start" and "restart": an explicit operator lifecycle command, the one
  // seam that is allowed to clear the health latch (see `WorkspaceProcesses.clearHealth`).
  await context.processes.clearHealth?.(binding);
  if (operation === "restart") {
    const id = requestId ?? crypto.randomUUID();
    const result = binding.restartResults?.find((entry) => entry.requestId === id);
    if (result?.status === "cancelled")
      throw new WorkspaceLifecycleSupersededError(
        binding.workspaceId,
        result.by ?? "stop",
        "restart",
      );
    if (result) return false;
    if (binding.restart && binding.restart.requestId !== id)
      throw new Error(
        `Workspace ${binding.workspaceId} has an unfinished restart. Run 'coforge-computer start --workspace ${binding.workspaceId}' to finish it, then restart again.`,
      );
    if (!binding.restart)
      binding = await context.saveBinding({
        ...binding,
        enabled: true,
        restart: {
          requestId: id,
          phase: "stopping",
          previousInstanceId: await context.processes.instance(binding),
        },
      });
    await context.advanceRestart(binding, signal);
  } else if (binding.restart) await context.advanceRestart(binding, signal);
  else await context.start(await context.saveBinding({ ...binding, enabled: true }), signal);
  return true;
}

/** The Workspaces a command acts on: an unscoped restart leaves disabled bindings alone. */

/**
 * Starts, stops, or restarts the targeted bindings and resolves with the Workspaces it started.
 * With a `deadline` the command answers by then even if it is still queued or under way: the
 * Workspaces it has not finished are `pending`, and their work completes in the serialized
 * queue afterwards, so an adopted instance and a restart's result are still recorded.
 */
export function runLifecycleCommand(
  context: MachineCommandContext,
  operation: "start" | "stop" | "restart",
  workspaceId?: string,
  requestId?: string,
  options: CommandOptions = {},
): Promise<CommandAnswer> {
  const requested = context.targets(operation, workspaceId).map(workspaceIdOf);
  const sequence =
    operation === "stop" ? context.supersede(requested, "stop") : context.nextSequence();
  const settle = context.markUnderWay(operation === "stop" ? [] : requested);
  const progress: CommandProgress = { done: 0, started: [], settle: settle.one };
  // A stop is persisted before it answers, so a Coordinator that dies before the stop's turn
  // comes back with the Workspace stopped, as the CLI was told.
  const intent = operation === "stop" ? context.persistStopIntent(requested, sequence) : undefined;
  const work = context
    .serialize(async () => {
      await intent;
      return runWorkspaceCommand(context, operation, workspaceId, requestId, sequence, progress);
    })
    .finally(() => {
      settle.all();
      if (operation === "stop") context.releaseStopIntents(requested, sequence);
    });
  const { deadline } = options;
  if (deadline === undefined) return work;
  const unhandled = () => (progress.targets ?? requested).slice(progress.done);
  const answer = () =>
    context.answerBy(
      deadline,
      work,
      () => {
        if (progress.refused) throw progress.refused;
        if (progress.superseded) throw progress.superseded;
        return { started: [...progress.started], pending: unhandled() };
      },
      (error) => context.recordFailureAfterAnswer(operation, unhandled(), error),
    );
  if (!intent) return answer();
  return intent.then(answer, (error: unknown) => {
    work.catch(() => {});
    throw error;
  });
}

/**
 * Stops every binding at once, for the Coordinator's own shutdown. A shutdown costs the slowest
 * Workspace rather than the sum of their stops: one stop may spend 30 s on the process-tree ladder
 * (task #726), and bindings stopped one after another could outlast launchd's `ExitTimeOut` and be
 * killed mid-teardown. Each binding's stop touches only its own unit and adoption record, so running
 * them together is safe. A failing stop still rejects the shutdown, with the rest already begun.
 */
export function stopEveryBinding(context: MachineCommandContext): Promise<void> {
  return context.serialize(async () => {
    await Promise.all(context.bindings().map((binding) => context.stop(binding)));
  });
}
