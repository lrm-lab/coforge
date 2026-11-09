import type { DaemonConfig } from "#src/daemon-runtime/runtime";
import type { DaemonCredentialStore } from "#src/credentials/credential-store";
import type { ComputerSelfClient } from "#src/connection/computer-self-client";
import { answeredWithin } from "./runner-hold";
import { SerialQueue } from "./serial-queue";
import {
  runLifecycleCommand,
  stopEveryBinding,
  type MachineCommandContext,
} from "./machine-supervisor-command";
import { detachManagedBinding } from "./machine-supervisor-detach";
import { cancelledRestartResults, stopped } from "./machine-supervisor-bindings";

export {
  LIFECYCLE_FAILURE_OPERATIONS,
  UPGRADE_OPERATION_HISTORY,
  UPGRADE_OPERATION_PENDING_TTL_MS,
} from "./machine-supervisor-operations";

export {
  type BindingStore,
  type CommandAnswer,
  type CommandOptions,
  type ManagedBinding,
  type RestartHoldTuning,
  type RestartProgress,
  type WorkspaceProcesses,
  WorkspaceRecoveryError,
} from "./machine-supervisor-contracts";
import {
  type BindingStore,
  type CommandAnswer,
  type CommandOptions,
  type ManagedBinding,
  type RestartHoldTuning,
  type WorkspaceProcesses,
  WorkspaceRecoveryError,
} from "./machine-supervisor-contracts";
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
  acknowledgeWorkspaceUpgrade,
  completeWorkspaceUpgrade,
  recordWorkspaceUpgrade,
  type MachineUpgradeContext,
} from "./machine-supervisor-upgrades";
import {
  clearLifecycleFailure,
  recordLifecycleFailureAfterAnswer,
  type MachineFailureContext,
} from "./machine-supervisor-failures";
import {
  persistStopIntent,
  releaseStopIntent,
  type MachineStopIntentContext,
} from "./machine-supervisor-stop-intents";
import { advanceWorkspaceRestart, type MachineRestartContext } from "./machine-supervisor-restart";
import {
  commandTargets,
  markWorkspacesUnderWay,
  supersedeWorkspaceWork,
  trackWorkspaceWork,
  type MachineInFlightContext,
} from "./machine-supervisor-inflight";
import {
  type LifecycleFailure,
  type PendingUpgradeSettler,
  type UpgradeOperationTerminal,
} from "./machine-supervisor-operations";

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
    return runLifecycleCommand(this.#commandOps, operation, workspaceId, requestId, options);
  }

  /** Persists these Workspaces as stopped now, ahead of the stop's turn in the queue. */
  #persistStopIntent(workspaceIds: readonly string[], sequence: number): Promise<void> {
    return persistStopIntent(this.#stopIntentOps, workspaceIds, sequence);
  }

  /** Ends this stop's hold over its Workspaces, unless a later stop took them over since. */
  #releaseStopIntents(workspaceIds: readonly string[], sequence: number): void {
    releaseStopIntent(this.#stopIntentOps, workspaceIds, sequence);
  }

  #failedAfterAnswer(
    operation: LifecycleFailure["operation"],
    workspaceIds: readonly string[],
    error: unknown,
  ): void {
    recordLifecycleFailureAfterAnswer(this.#failureOps, operation, workspaceIds, error);
  }

  /** Drops a Workspace's recorded failure once a lifecycle step for it succeeded. */
  async #clearFailure(workspaceId: string): Promise<void> {
    return clearLifecycleFailure(this.#failureOps, workspaceId);
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
    return supersedeWorkspaceWork(this.#inFlightOps, workspaceIds, by);
  }

  /** Marks these Workspaces under way until each is settled (or all are, once the work ends). */
  #markUnderWay(workspaceIds: readonly string[]) {
    return markWorkspacesUnderWay(this.#inFlightOps, workspaceIds);
  }

  /** Runs one Workspace's start/restart work where a stop or configure can abort it. */
  #track<T>(workspaceId: string, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    return trackWorkspaceWork(this.#inFlightOps, workspaceId, run);
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
  /**
   * Opens one upgrade operation. Returns whether this call is the one that must launch the
   * external job; a replay of the same request ID returns false. Operations are mutually
   * exclusive: a second request while another is still pending is rejected outright rather than
   * left to collide over the installation lock.
   */
  recordUpgrade(workspaceId: string, requestId: string, expectedVersion: string) {
    return this.#serialize(() =>
      recordWorkspaceUpgrade(this.#upgradeOps, workspaceId, requestId, expectedVersion),
    );
  }

  /** Records the durable receipt an operation's external job left behind. */
  completeUpgrade(
    workspaceId: string,
    requestId: string,
    terminal: { status: "succeeded" | "failed" } & UpgradeOperationTerminal,
  ) {
    return this.#serialize(() =>
      completeWorkspaceUpgrade(this.#upgradeOps, workspaceId, requestId, terminal),
    );
  }

  /** The server accepted the reported result; the record becomes audit-only history. */
  acknowledgeUpgrade(workspaceId: string, requestId: string) {
    return this.#serialize(() =>
      acknowledgeWorkspaceUpgrade(this.#upgradeOps, workspaceId, requestId),
    );
  }

  snapshot() {
    return this.#serialize(async () => {
      await this.#refresh();
      return this.view();
    });
  }

  shutdown() {
    return stopEveryBinding(this.#commandOps);
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
    return advanceWorkspaceRestart(this.#restartOps, binding, signal);
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

  /** One lifecycle command's view of this supervisor: the process seams and the mutation
   * primitives the command pipeline in `machine-supervisor-command.ts` calls. */
  get #commandOps(): MachineCommandContext {
    return {
      processes: this.processes,
      refresh: () => this.#refresh(),
      bindings: () => this.#bindings,
      targets: (operation, workspaceId) =>
        commandTargets(this.#inFlightOps, operation, workspaceId),
      saveBinding: (binding) => this.#saveBinding(binding),
      stop: (binding) => this.#stop(binding),
      clearFailure: (workspaceId) => this.#clearFailure(workspaceId),
      supersededBy: (workspaceId) => this.#supersededAt.get(workspaceId),
      track: (workspaceId, run) => this.#track(workspaceId, run),
      advanceRestart: (binding, signal) => this.#advanceRestart(binding, signal),
      start: (binding, signal) => this.#start(binding, signal),
      supersede: (workspaceIds, by) => this.#supersede(workspaceIds, by),
      nextSequence: () => ++this.#sequence,
      markUnderWay: (workspaceIds) => this.#markUnderWay(workspaceIds),
      persistStopIntent: (workspaceIds, sequence) =>
        this.#persistStopIntent(workspaceIds, sequence),
      releaseStopIntents: (workspaceIds, sequence) =>
        this.#releaseStopIntents(workspaceIds, sequence),
      recordFailureAfterAnswer: (operation, workspaceIds, error) =>
        this.#failedAfterAnswer(operation, workspaceIds, error),
      serialize: (operation) => this.#serialize(operation),
      answerBy: (deadline, work, early, late) => this.#answerBy(deadline, work, early, late),
    };
  }

  get #upgradeOps(): MachineUpgradeContext {
    return {
      refresh: () => this.#refresh(),
      bindings: () => this.#bindings,
      saveBinding: (binding) => this.#saveBinding(binding),
      settlePendingUpgrade: this.settlePendingUpgrade,
      now: this.now,
    };
  }

  /** The in-flight bookkeeping's view; the maps are shared by reference so `view()` and
   * `#command` keep reading them directly. */
  get #inFlightOps(): MachineInFlightContext {
    return {
      bindings: () => this.#bindings,
      inFlight: this.#inFlight,
      underWay: this.#underWay,
      supersededAt: this.#supersededAt,
      nextSequence: () => ++this.#sequence,
    };
  }

  /** The restart progression's view of this Coordinator's process and store-write path. */
  get #restartOps(): MachineRestartContext {
    return {
      processes: this.processes,
      restartHold: this.restartHold,
      stop: (binding) => this.#stop(binding),
      start: (binding, signal) => this.#start(binding, signal),
      saveBinding: (binding) => this.#saveBinding(binding),
    };
  }

  /** The stop intents' view of this Coordinator's store-write path. */
  get #stopIntentOps(): MachineStopIntentContext {
    return {
      stopIntents: this.#stopIntents,
      bindings: () => this.#bindings,
      reloadIfRequired: () => this.#reloadIfRequired(),
      exclusive: (write) => this.#exclusive(write),
      store: (next) => this.#store(next),
    };
  }

  /** The failure recorder's view; unlike the upgrade operations it re-enters `#serialize`
   * itself, so its context exposes it. */
  get #failureOps(): MachineFailureContext {
    return {
      refresh: () => this.#refresh(),
      bindings: () => this.#bindings,
      saveBinding: (binding) => this.#saveBinding(binding),
      serialize: (operation) => this.#serialize(operation),
      now: this.now,
    };
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    return this.#mutation.run(operation);
  }
}
