import { getLogger } from "@logtape/logtape";
import {
  RUNNER_HOLD_REASONS,
  type DaemonConnectRejectionReason,
  type RunnerHoldReason,
  thrownMessage,
} from "@lrm/coforge-sdk/internal";
import type { DaemonConfig } from "#src/daemon-runtime/runtime";
import type { DaemonCredentialStore } from "#src/credentials/credential-store";
import type { ComputerSelfClient } from "#src/connection/computer-self-client";
import { answeredWithin, holdRunnersUntilQuiescent, type RunnerHoldSnapshot } from "./runner-hold";
import { UpgradeOperationPendingError } from "./upgrade-error";
import { WorkspaceParkedError } from "./workspace-health-journal";
import { WorkspaceLifecycleSupersededError } from "./lifecycle-superseded-error";
import { SerialQueue } from "./serial-queue";
import { detachManagedBinding } from "./machine-supervisor-detach";
import {
  appendRestartResult,
  cancelledRestartResults,
  stopped,
  workspaceIdOf,
} from "./machine-supervisor-bindings";

export type RestartProgress = {
  requestId: string;
  phase: "stopping" | "starting";
  previousInstanceId: string | null;
};
export type ManagedBinding = DaemonConfig & {
  enabled: boolean;
  restart?: RestartProgress;
  restartResults?: RestartResult[];
  /** Legacy cloud ready hints, never proof of a completed local operation. */
  restartRequestIds?: string[];
  upgradeRequestIds?: string[];
  /** Pre-receipt dedupe list; FileBindingStore reopens these as pending operations. */
  upgradeRequests?: { requestId: string; expectedVersion: string }[];
  upgradeOperations?: UpgradeOperation[];
  /** The last operator command that failed for this Workspace after it had already answered, so
   * `coforge-computer status` can say so; cleared by the next one that succeeds. */
  lastFailure?: LifecycleFailure;
  /** `daemon:detach` (task #417): the server already answered once, so a retry finishes the
   * local half alone — stop, unbind, delete the credential — without asking again. */
  detachConfirmed?: boolean;
  /** `daemon:detach`: the server answered `computer_key_revoked` (task #417). */
  detachKeyRevoked?: boolean;
};

export {
  LIFECYCLE_FAILURE_OPERATIONS,
  UPGRADE_OPERATION_HISTORY,
  UPGRADE_OPERATION_PENDING_TTL_MS,
} from "./machine-supervisor-operations";
export type {
  LifecycleFailure,
  PendingUpgradeSettlement,
  PendingUpgradeSettler,
  RestartResult,
  UpgradeOperation,
  UpgradeOperationState,
  UpgradeOperationTerminal,
} from "./machine-supervisor-operations";
import {
  type LifecycleFailure,
  UPGRADE_OPERATION_HISTORY,
  type PendingUpgradeSettler,
  type RestartResult,
  type UpgradeOperation,
  type UpgradeOperationTerminal,
} from "./machine-supervisor-operations";

export class WorkspaceRecoveryError extends AggregateError {}
export interface BindingStore {
  load(): Promise<ManagedBinding[]>;
  save(bindings: ManagedBinding[]): Promise<void>;
}
/**
 * An operator command's one deadline (epoch ms). It bounds when the command answers, not the work:
 * what is still under way at the deadline finishes in the serialized queue after the answer.
 */
export type CommandOptions = { deadline?: number };
/** Which targeted Workspaces an operator command finished starting, and which were still under
 * way (queued, holding, stopping, or starting) when its deadline came. */
export type CommandAnswer = { started: string[]; pending: string[] };

/** What one command has got through so far, read when its deadline answers before it finishes:
 * its targets are handled in order, so the first `done` of them are finished. */
type CommandProgress = {
  targets?: string[];
  done: number;
  started: string[];
  refused?: WorkspaceParkedError;
  superseded?: WorkspaceLifecycleSupersededError;
  /** Ends a target's under-way mark once it has been handled. */
  settle(workspaceId: string): void;
};

export interface WorkspaceProcesses {
  /** Gives up with `signal.reason` once `signal` aborts (a stop or configure took over). */
  start(binding: ManagedBinding, options?: { signal?: AbortSignal }): Promise<string>;
  stop(binding: ManagedBinding): Promise<void>;
  instance(binding: ManagedBinding): Promise<string | null>;
  /**
   * Asks one Workspace daemon to stop admitting new turns and reports which of its Agents are
   * still busy. Optional: a `WorkspaceProcesses` that cannot reach its children simply restarts
   * with today's behaviour.
   */
  hold?(binding: ManagedBinding, reason: RunnerHoldReason): Promise<RunnerHoldSnapshot>;
  /** Lifts a hold on a daemon that, against expectations, survived: only called when the OS stop
   * after a hold failed, so the still-running daemon does not sit held with nobody to lift it. */
  release?(binding: ManagedBinding, reason: RunnerHoldReason): Promise<unknown>;
  /** Clears this Workspace's crash/terminal health latch. Called only for an explicit operator
   * `start`/`restart` through `command()` - never from automatic recovery on Coordinator startup,
   * and never from `stop` - so an OS-level crash-loop restart (which never reaches `command()`)
   * cannot clear its own latch. Optional: a `WorkspaceProcesses` with no health journal to clear
   * simply never latches. */
  clearHealth?(binding: ManagedBinding): Promise<void>;
  /** Why the cloud refused this Workspace for good, if it did. A parked Workspace is never
   * started by recovery, start, or restart; only `configure` (a rebind) lifts the park. */
  parkedReason?(binding: ManagedBinding): Promise<DaemonConnectRejectionReason | undefined>;
  clearParked?(binding: ManagedBinding): Promise<void>;
}

/** Test seam for the bounded restart hold; production takes every default. */
export type RestartHoldTuning = {
  holdMs?: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
};

const logger = getLogger(["coforge", "daemon", "supervisor"]);

/** Serial machine mutations; a stopped binding remains registered and recoverable. */
export class MachineSupervisor {
  #bindings: ManagedBinding[] = [];
  #instances = new Map<string, string>();
  /** Start/restart work under way per Workspace; a stop or configure aborts it. */
  #inFlight = new Map<string, AbortController>();
  /** Request order: a stop or configure supersedes every start/restart of its Workspace requested
   * before it (the sequence of the latest one per Workspace). */
  #sequence = 0;
  #supersededAt = new Map<string, { sequence: number; by: "stop" | "configure" }>();
  /** Start/restart/configure requests per Workspace, from request until handled: queued or
   * running, what the view reports as under way. */
  #underWay = new Map<string, number>();
  /** Workspaces a stop has already persisted as stopped while its own turn in the queue is still
   * to come (the sequence of that stop). Any save of them meanwhile keeps them stopped. */
  #stopIntents = new Map<string, number>();
  /** Store writes, one at a time: a stop's intent is written outside the lifecycle queue. */
  #writing = new SerialQueue();
  #mutation = new SerialQueue();
  #reloadRequired = false;
  constructor(
    private readonly store: BindingStore,
    private readonly processes: WorkspaceProcesses,
    private readonly now: () => number = Date.now,
    private readonly restartHold: RestartHoldTuning = {},
    /**
     * Consulted only when a new upgrade request is blocked by a pending one, so `recordUpgrade`
     * can settle a stale blocker instead of refusing outright (a genuinely in-flight operation is
     * still refused). Omit it to keep the previous behaviour of always refusing.
     */
    private readonly settlePendingUpgrade?: PendingUpgradeSettler,
  ) {}

  recover() {
    return this.#serialize(async () => {
      this.#bindings = await this.store.load();
      this.#reloadRequired = false;
      await this.#reconcileBindings();
    });
  }

  /**
   * Re-applies enabled/disabled intent for every binding. Used on Coordinator startup and,
   * on Windows (no OS-level Workspace restart), by a periodic poll that replaces systemd/launchd
   * failure restart.
   */
  reconcile() {
    return this.#serialize(async () => {
      await this.#refresh();
      await this.#reconcileBindings();
    });
  }

  /** Attaches (or re-attaches) a Workspace and starts it. It takes over a start or restart of the
   * same Workspace still under way or queued; a restart it replaces is recorded cancelled. */
  configure(config: DaemonConfig, options: CommandOptions = {}): Promise<{ pending: boolean }> {
    this.#supersede([config.workspaceId], "configure");
    const settle = this.#markUnderWay([config.workspaceId]);
    const work = this.#serialize(async () => {
      await this.#refresh();
      const previous = this.#bindings.find((binding) => binding.workspaceId === config.workspaceId);
      if (previous) await this.#stop(previous);
      const binding = {
        ...config,
        enabled: true,
        restartResults: previous ? cancelledRestartResults(previous, "configure") : undefined,
      };
      await this.processes.clearParked?.(binding);
      await this.#saveBinding(binding);
      await this.#track(binding.workspaceId, (signal) => this.#start(binding, signal));
      await this.#clearFailure(binding.workspaceId);
      return { pending: false };
    }).finally(settle.all);
    // With a deadline it answers like a command: the configuration is taken, its start finishes
    // behind the answer, and a later failure is recorded for `status`.
    const { deadline } = options;
    if (deadline === undefined) return work;
    return this.#answerBy(
      deadline,
      work,
      () => ({ pending: true }),
      (error) => this.#failedAfterAnswer("configure", [config.workspaceId], error),
    );
  }

  /**
   * Starts, stops, or restarts the targeted bindings and resolves with the Workspaces it started.
   * With a `deadline` the command answers by then even if it is still queued or under way: the
   * Workspaces it has not finished are `pending`, and their work completes in the serialized
   * queue afterwards, so an adopted instance and a restart's result are still recorded.
   */
  command(
    operation: "start" | "stop" | "restart",
    workspaceId?: string,
    requestId?: string,
    options: CommandOptions = {},
  ): Promise<CommandAnswer> {
    const requested = this.#targets(operation, workspaceId).map(workspaceIdOf);
    const sequence = operation === "stop" ? this.#supersede(requested, "stop") : ++this.#sequence;
    const settle = this.#markUnderWay(operation === "stop" ? [] : requested);
    const progress: CommandProgress = { done: 0, started: [], settle: settle.one };
    // A stop is persisted before it answers, so a Coordinator that dies before the stop's turn
    // comes back with the Workspace stopped, as the CLI was told.
    const intent = operation === "stop" ? this.#persistStopIntent(requested, sequence) : undefined;
    const work = this.#serialize(async () => {
      await intent;
      return this.#command(operation, workspaceId, requestId, sequence, progress);
    }).finally(() => {
      settle.all();
      if (operation === "stop") this.#releaseStopIntents(requested, sequence);
    });
    const { deadline } = options;
    if (deadline === undefined) return work;
    const unhandled = () => (progress.targets ?? requested).slice(progress.done);
    const answer = () =>
      this.#answerBy(
        deadline,
        work,
        () => {
          if (progress.refused) throw progress.refused;
          if (progress.superseded) throw progress.superseded;
          return { started: [...progress.started], pending: unhandled() };
        },
        (error) => this.#failedAfterAnswer(operation, unhandled(), error),
      );
    if (!intent) return answer();
    return intent.then(answer, (error: unknown) => {
      work.catch(() => {});
      throw error;
    });
  }

  /** Persists these Workspaces as stopped now, ahead of the stop's turn in the queue. */
  async #persistStopIntent(workspaceIds: readonly string[], sequence: number): Promise<void> {
    for (const id of workspaceIds) this.#stopIntents.set(id, sequence);
    try {
      await this.#exclusive(async () => {
        await this.#reloadIfRequired();
        const next = this.#bindings.map((binding) =>
          this.#stopIntents.has(binding.workspaceId) ? stopped(binding) : binding,
        );
        await this.#store(next);
      });
    } catch (error) {
      // The stop fails as a whole (its queued turn sees the same error), so nothing stays forced.
      this.#releaseStopIntents(workspaceIds, sequence);
      throw error;
    }
  }

  /** Ends this stop's hold over its Workspaces, unless a later stop took them over since. */
  #releaseStopIntents(workspaceIds: readonly string[], sequence: number): void {
    for (const id of workspaceIds)
      if (this.#stopIntents.get(id) === sequence) this.#stopIntents.delete(id);
  }

  /**
   * Nobody waits for a command that failed after it answered, so its failure is logged and
   * recorded on the Workspaces it had not handled yet, where `status` shows it. A park or a stop
   * or configure that took over is not a failure of this kind: `status` already shows the park,
   * and the operator asked for the takeover.
   */
  #failedAfterAnswer(
    operation: LifecycleFailure["operation"],
    workspaceIds: readonly string[],
    error: unknown,
  ): void {
    const message =
      thrownMessage(error) ||
      `The ${operation} failed without a reason; the Computer log has the details.`;
    if (error instanceof WorkspaceParkedError || error instanceof WorkspaceLifecycleSupersededError)
      return;
    logger.warn("A lifecycle command failed after it had already answered", {
      event: "lifecycle:command_failed_after_answer",
      operation,
      workspace_ids: workspaceIds,
      error_message: message,
    });
    void this.#serialize(async () => {
      await this.#refresh();
      for (const id of workspaceIds) {
        const binding = this.#bindings.find((entry) => entry.workspaceId === id);
        if (binding)
          await this.#saveBinding({
            ...binding,
            lastFailure: { operation, message: message.slice(0, 500), at: this.now() },
          });
      }
    }).catch((recordError: unknown) => {
      logger.warn("Recording a lifecycle failure for status failed", {
        event: "lifecycle:failure_record_failed",
        error_message: thrownMessage(recordError),
      });
    });
  }

  /** Drops a Workspace's recorded failure once a lifecycle step for it succeeded. */
  async #clearFailure(workspaceId: string): Promise<void> {
    const binding = this.#bindings.find((entry) => entry.workspaceId === workspaceId);
    if (binding?.lastFailure) await this.#saveBinding({ ...binding, lastFailure: undefined });
  }

  /**
   * The bindings as this supervisor last recorded them, each with its live OS instance, without
   * waiting behind a lifecycle mutation still under way. What an operator reads (`status`, a
   * command's answer) comes from here, so it never outlasts its caller.
   */
  async view() {
    return Promise.all(
      this.#bindings.map(async (binding) => ({
        ...binding,
        instanceId: await this.processes.instance(binding),
        /** A start or restart of this Workspace is under way. */
        inFlight:
          this.#inFlight.has(binding.workspaceId) ||
          (this.#underWay.get(binding.workspaceId) ?? 0) > 0,
      })),
    );
  }

  /** Takes over the start/restart work of these Workspaces requested so far; returns this
   * request's sequence. */
  #supersede(workspaceIds: readonly string[], by: "stop" | "configure"): number {
    const sequence = ++this.#sequence;
    for (const id of workspaceIds) {
      this.#supersededAt.set(id, { sequence, by });
      this.#inFlight.get(id)?.abort(new WorkspaceLifecycleSupersededError(id, by));
    }
    return sequence;
  }

  /** Marks these Workspaces under way until each is settled (or all are, once the work ends). */
  #markUnderWay(workspaceIds: readonly string[]) {
    const marked = new Set(workspaceIds);
    for (const id of marked) this.#underWay.set(id, (this.#underWay.get(id) ?? 0) + 1);
    const one = (id: string) => {
      if (!marked.delete(id)) return;
      const count = (this.#underWay.get(id) ?? 1) - 1;
      if (count > 0) this.#underWay.set(id, count);
      else this.#underWay.delete(id);
    };
    return { one, all: () => [...marked].forEach(one) };
  }

  /** Runs one Workspace's start/restart work where a stop or configure can abort it. */
  async #track<T>(workspaceId: string, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    this.#inFlight.set(workspaceId, controller);
    try {
      return await run(controller.signal);
    } finally {
      if (this.#inFlight.get(workspaceId) === controller) this.#inFlight.delete(workspaceId);
    }
  }

  /** The Workspaces a command acts on: an unscoped restart leaves disabled bindings alone. */
  #targets(operation: "start" | "stop" | "restart", workspaceId?: string): ManagedBinding[] {
    return this.#bindings.filter(
      (binding) =>
        (!workspaceId || binding.workspaceId === workspaceId) &&
        !(operation === "restart" && !workspaceId && !binding.enabled),
    );
  }

  async #command(
    operation: "start" | "stop" | "restart",
    workspaceId: string | undefined,
    requestId: string | undefined,
    sequence: number,
    progress: CommandProgress,
  ): Promise<CommandAnswer> {
    await this.#refresh();
    if (workspaceId && !this.#bindings.some((binding) => binding.workspaceId === workspaceId))
      throw new Error("Workspace is not registered locally");
    const targets = this.#targets(operation, workspaceId);
    progress.targets = targets.map(workspaceIdOf);
    for (let binding of targets) {
      const id = binding.workspaceId;
      if (operation === "stop") {
        binding = await this.#saveBinding(stopped(binding));
        await this.#stop(binding);
        await this.#clearFailure(id);
      } else {
        // The other targets still start; the refusal names the parked one once they have.
        const reason = await this.processes.parkedReason?.(binding);
        if (reason) {
          // A parked binding the operator stopped stays out of an unscoped start.
          if (workspaceId || binding.enabled)
            progress.refused ??= new WorkspaceParkedError(id, reason);
        } else if ((this.#supersededAt.get(id)?.sequence ?? 0) > sequence) {
          // A stop or configure requested after this command takes precedence.
          const { by } = this.#supersededAt.get(id)!;
          progress.superseded ??= new WorkspaceLifecycleSupersededError(id, by, operation);
          // Record it like one taken over while running, so a replay neither runs nor re-enables.
          if (
            operation === "restart" &&
            requestId &&
            binding.restart?.requestId !== requestId &&
            !binding.restartResults?.some((entry) => entry.requestId === requestId)
          )
            await this.#saveBinding({
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
              await this.#track(id, (signal) =>
                this.#startForOperator(operation, current, requestId, signal),
              )
            )
              progress.started.push(id);
            await this.#clearFailure(id);
          } catch (error) {
            // It parked as it started (the cloud refused it at once): the rest still start.
            if (error instanceof WorkspaceParkedError) progress.refused ??= error;
            else if (error instanceof WorkspaceLifecycleSupersededError)
              progress.superseded ??= new WorkspaceLifecycleSupersededError(
                id,
                error.by,
                operation,
              );
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

  /**
   * Settles with `work` if it finishes by `deadline`, otherwise with `early()`. Work that outlives
   * the answer keeps running; a later failure goes to `late`, since nobody is waiting for it.
   */
  async #answerBy<T>(
    deadline: number,
    work: Promise<T>,
    early: () => T,
    late: (error: unknown) => void,
  ): Promise<T> {
    const finished = await answeredWithin(
      work.then(
        () => true,
        () => true,
      ),
      Math.max(0, deadline - this.now()),
      "lifecycle command deadline",
    ).catch(() => false);
    if (finished) return work;
    work.catch(late);
    return early();
  }

  /** Resolves false for a restart this request already completed (nothing started). */
  async #startForOperator(
    operation: "start" | "restart",
    binding: ManagedBinding,
    requestId: string | undefined,
    signal: AbortSignal,
  ): Promise<boolean> {
    // Reached only for "start" and "restart": an explicit operator lifecycle command, the one
    // seam that is allowed to clear the health latch (see `WorkspaceProcesses.clearHealth`).
    await this.processes.clearHealth?.(binding);
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
        binding = await this.#saveBinding({
          ...binding,
          enabled: true,
          restart: {
            requestId: id,
            phase: "stopping",
            previousInstanceId: await this.processes.instance(binding),
          },
        });
      await this.#advanceRestart(binding, signal);
    } else if (binding.restart) await this.#advanceRestart(binding, signal);
    else await this.#start(await this.#saveBinding({ ...binding, enabled: true }), signal);
    return true;
  }

  /**
   * Opens one upgrade operation. Returns whether this call is the one that must launch the
   * external job; a replay of the same request ID returns false. Operations are mutually
   * exclusive: a second request while another is still pending is rejected outright rather than
   * left to collide over the installation lock.
   */
  recordUpgrade(workspaceId: string, requestId: string, expectedVersion: string) {
    return this.#serialize(async () => {
      await this.#refresh();
      const binding = this.#bindings.find((entry) => entry.workspaceId === workspaceId);
      if (!binding) throw new Error("Workspace is not registered locally");
      if (!expectedVersion) throw new Error("upgrade expected version is required");
      let operations = binding.upgradeOperations ?? [];
      const existing = operations.find((entry) => entry.requestId === requestId);
      if (existing) {
        if (existing.expectedVersion !== expectedVersion)
          throw new Error("upgrade request already has a different expected version");
        return false;
      }
      const pending = operations.find((entry) => entry.state === "pending");
      if (pending) {
        // A settle-able pending slot (its job left a receipt, or it aged past the TTL) must not
        // refuse a new request forever; only an in-flight operation blocks. `settlePendingUpgrade`
        // only reads; this applies it in the same mutation, not via `completeUpgrade`.
        const settlement = await this.settlePendingUpgrade?.(
          workspaceId,
          pending.requestId,
          pending.requestedAt,
        ).catch((error) => {
          logger.warn("Settling a pending Computer upgrade operation failed; still refusing", {
            event: "upgrade:pending_settle_check_failed",
            request_id: pending.requestId,
            workspace_id: workspaceId,
            error_message: thrownMessage(error),
          });
          return undefined;
        });
        if (!settlement)
          throw new UpgradeOperationPendingError(
            `Computer upgrade operation ${pending.requestId} is still pending; wait for it to finish before starting another`,
          );
        const { status, ...terminal } = settlement;
        operations = operations.map((entry) =>
          entry.requestId === pending.requestId ? { ...entry, state: status, terminal } : entry,
        );
        logger.info("Computer upgrade operation reached its terminal state", {
          event: "upgrade:operation_settled",
          request_id: pending.requestId,
          workspace_id: workspaceId,
          status,
          ...(terminal.errorCode ? { error_code: terminal.errorCode } : {}),
        });
      }
      await this.#saveBinding({
        ...binding,
        upgradeOperations: [
          ...operations,
          { requestId, expectedVersion, state: "pending" as const, requestedAt: this.now() },
        ].slice(-UPGRADE_OPERATION_HISTORY),
      });
      return true;
    });
  }

  /** Records the durable receipt an operation's external job left behind. */
  completeUpgrade(
    workspaceId: string,
    requestId: string,
    terminal: { status: "succeeded" | "failed" } & UpgradeOperationTerminal,
  ) {
    return this.#serialize(async () => {
      await this.#refresh();
      const binding = this.#bindings.find((entry) => entry.workspaceId === workspaceId);
      const operation = binding?.upgradeOperations?.find((entry) => entry.requestId === requestId);
      if (!binding || !operation || operation.state !== "pending") return false;
      const { status, ...receipt } = terminal;
      await this.#saveBinding({
        ...binding,
        upgradeOperations: binding.upgradeOperations!.map((entry) =>
          entry.requestId === requestId ? { ...entry, state: status, terminal: receipt } : entry,
        ),
      });
      return true;
    });
  }

  /** The server accepted the reported result; the record becomes audit-only history. */
  acknowledgeUpgrade(workspaceId: string, requestId: string) {
    return this.#serialize(async () => {
      await this.#refresh();
      const binding = this.#bindings.find((entry) => entry.workspaceId === workspaceId);
      const operation = binding?.upgradeOperations?.find((entry) => entry.requestId === requestId);
      if (!binding || !operation) return false;
      if (operation.state === "acknowledged") return true;
      if (operation.state === "pending")
        throw new Error("a pending Computer upgrade operation cannot be acknowledged");
      await this.#saveBinding({
        ...binding,
        upgradeOperations: binding.upgradeOperations!.map((entry) =>
          entry.requestId === requestId ? { ...entry, state: "acknowledged" as const } : entry,
        ),
      });
      return true;
    });
  }

  snapshot() {
    return this.#serialize(async () => {
      await this.#refresh();
      return this.view();
    });
  }

  shutdown() {
    return this.#serialize(async () => {
      for (const binding of this.#bindings) await this.#stop(binding);
    });
  }

  async #reconcileBindings(): Promise<void> {
    const failures: Error[] = [];
    for (const workspaceId of this.#bindings.map((binding) => binding.workspaceId)) {
      await this.#refresh();
      const binding = this.#bindings.find((entry) => entry.workspaceId === workspaceId)!;
      try {
        if (!binding.enabled) await this.#stop(binding);
        else if (await this.processes.parkedReason?.(binding)) continue;
        else if (binding.restart)
          await this.#track(workspaceId, (signal) => this.#advanceRestart(binding, signal));
        else await this.#track(workspaceId, (signal) => this.#start(binding, signal));
        await this.#clearFailure(workspaceId);
      } catch (cause) {
        failures.push(new Error(`Workspace ${workspaceId} recovery failed`, { cause }));
      }
    }
    if (failures.length)
      throw new WorkspaceRecoveryError(failures, "Workspace recovery incomplete");
  }

  async #advanceRestart(binding: ManagedBinding, signal?: AbortSignal): Promise<void> {
    const restart = binding.restart!;
    if (restart.phase === "stopping") {
      const current = await this.processes.instance(binding);
      // The same stable OS unit may already have replaced its failed invocation.
      // start below still validates the replacement through its scoped handshake.
      if (current === null || current === restart.previousInstanceId) {
        // Only a live instance is worth holding; a dead one has no Agents left to drain.
        if (current !== null) await this.#holdRunners(binding, signal);
        // A stop or configure took over while the Agents drained: it stops the daemon itself.
        signal?.throwIfAborted();
        try {
          await this.#stop(binding);
        } catch (error) {
          // The daemon we meant to kill is still up and still held: lift the hold before
          // surfacing the failure, or its Agents would queue turns until someone retries.
          if (current !== null)
            await this.processes
              .release?.(binding, RUNNER_HOLD_REASONS.WORKSPACE_RESTART)
              .catch(() => {});
          throw error;
        }
      }
      binding = await this.#saveBinding({ ...binding, restart: { ...restart, phase: "starting" } });
    }
    const instanceId = await this.#start(binding, signal);
    if (instanceId === restart.previousInstanceId)
      throw new Error("Workspace restart did not replace the old instance");
    await this.#saveBinding({
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
   * `#stop` hands the Agents the ~2s SIGTERM/SIGKILL ladder in `DaemonRuntime.stop()`, which is
   * not enough for a tool call. Only `restart` holds: `stop` is an operator saying "now".
   *
   * Nothing releases the hold afterwards, and nothing needs to. It is in-memory in the Workspace
   * daemon and `#stop` kills that process; the replacement is born without a hold
   * (the hold is never persisted). The one exception is a stop that fails: the daemon survives
   * held, so `#advanceRestart` releases it before rethrowing; a later retry re-asks, which is
   * idempotent.
   *
   * The wait runs inside the serialized mutation, so other lifecycle commands queue behind it for
   * up to `RUNNER_HOLD_MS`. That is accepted: a restart that raced ahead of the drain would defeat the point. An
   * operator restart keeps the full bound too: its answer is bounded by its deadline
   * (`#answerBy`), not by cutting the drain short for Agents mid tool call.
   *
   * Every failure resolves towards proceeding: `holdRunnersUntilQuiescent` reports quiescent when
   * the hold cannot be asked at all, and a Workspace that answers `accepted: false` or times out
   * is counted as idle. A restart is never failed because of the hold.
   */
  async #holdRunners(binding: ManagedBinding, signal?: AbortSignal): Promise<void> {
    if (!this.processes.hold) return;
    const outcome = await holdRunnersUntilQuiescent({
      hold: () => this.processes.hold!(binding, RUNNER_HOLD_REASONS.WORKSPACE_RESTART),
      ...this.restartHold,
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
  async #saveBinding(binding: ManagedBinding): Promise<ManagedBinding> {
    // A Workspace a stop already persisted stays stopped, whatever older work saves meanwhile.
    const stored = this.#stopIntents.has(binding.workspaceId) ? stopped(binding) : binding;
    await this.#exclusive(async () => {
      const next = this.#bindings.filter((entry) => entry.workspaceId !== stored.workspaceId);
      const index = this.#bindings.findIndex((entry) => entry.workspaceId === stored.workspaceId);
      next.splice(index < 0 ? next.length : index, 0, stored);
      await this.#store(next);
    });
    return stored;
  }
  async #store(next: ManagedBinding[]): Promise<void> {
    try {
      await this.store.save(next);
    } catch (error) {
      // A failure after rename may have committed. Re-read before any later mutation.
      this.#reloadRequired = true;
      throw error;
    }
    this.#bindings = next;
  }
  async #refresh() {
    await this.#exclusive(() => this.#reloadIfRequired());
  }
  async #reloadIfRequired() {
    if (!this.#reloadRequired) return;
    this.#bindings = await this.store.load();
    this.#reloadRequired = false;
  }
  #exclusive<T>(write: () => Promise<T>): Promise<T> {
    return this.#writing.run(write);
  }
  async #start(binding: ManagedBinding, signal?: AbortSignal): Promise<string> {
    const expected = this.#instances.get(binding.workspaceId);
    if (expected && (await this.processes.instance(binding)) === expected) return expected;
    this.#instances.delete(binding.workspaceId);
    signal?.throwIfAborted();
    const instanceId = await this.processes.start(binding, signal ? { signal } : {});
    this.#instances.set(binding.workspaceId, instanceId);
    return instanceId;
  }
  async #stop(binding: ManagedBinding) {
    await this.processes.stop(binding);
    this.#instances.delete(binding.workspaceId);
  }

  /** `daemon:detach` (task #417 step 3): the Workspace's binding and credential go only on a
   * definite server answer — see `machine-supervisor-detach.ts`. */
  detach(
    workspaceId: string,
    deps: {
      credentials: Pick<DaemonCredentialStore, "load" | "delete">;
      makeSelfClient: (serverHttpUrl: string) => Pick<ComputerSelfClient, "detach">;
      /** For a Workspace this supervisor has no binding for: the requesting Computer's own id
       * and server, so its credential's key can still be told to unlink (task #417). */
      target?: { computerId: string; serverHttpUrl: string };
    },
  ): Promise<
    | { detached: true; keyRevoked?: boolean }
    | { detached: false; reason: "unconfirmed" | "not_bound" }
  > {
    return this.#serialize(() =>
      detachManagedBinding({
        workspaceId,
        bindings: this.#bindings,
        stop: (binding) => this.#stop(binding),
        store: (next) => this.#store(next),
        credentials: deps.credentials,
        makeSelfClient: deps.makeSelfClient,
        target: deps.target,
      }),
    );
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    return this.#mutation.run(operation);
  }
}
