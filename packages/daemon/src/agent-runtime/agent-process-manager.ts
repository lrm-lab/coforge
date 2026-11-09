import { AgentStateMachine, type AgentStatus } from "./agent-state-machine";
import type { AgentRuntimeConfig, AgentSession } from "@coforge/agent";
import type { CodeAgentProviderFactory } from "@lrm/coforge-anvil";
import { AgentProcessCleanupError, withDeadline } from "@lrm/coforge-anvil";
import {
  createAgentSession,
  prepareAgentLaunch,
  type AgentLaunchInput,
  type AgentLaunchPreparationPorts,
} from "./agent-launch-preparation";
import type { ConversationSessionStore } from "./memory-conversation-sessions";
import { resolveGitHookInjectionForLaunch } from "#src/code-agent/git-hooks";
import { processClockMs } from "#src/platform/process-tree";
import { confirmGone, throwStopFailure, UNCLEARED, type AgentTeardown } from "./agent-teardown";

export type { AgentStatus } from "./agent-state-machine";

export type AgentRuntime = Readonly<{
  config: AgentRuntimeConfig;
  session: AgentSession;
}>;

export type AgentRestartConfig = Readonly<{
  config: AgentRuntimeConfig;
  sessionId: string | undefined;
  /** The server's last launch identity for this Agent, set on a managed launch
   * or a rebind. A self-initiated (daemon-woken) launch reuses it instead of minting a new
   * `launchId`. A successful `start()` registers it with the runtime's restart config;
   * `stop()`/`shutdown()` delete it along with everything else this Agent could be woken from. */
  serverLaunch?: ServerLaunchIdentity;
}>;

/** The runtime fields a pushed configuration replaces on a remembered restart config. */
export type RestartRuntimeFields = Pick<
  AgentRuntimeConfig,
  "provider" | "model" | "modelProvider" | "reasoning" | "providerConfig" | "fastMode"
>;

export type AgentTurnInterruptResult = "interrupted" | "restarted" | "not_running";

export type AgentTurnInterruptOptions = Readonly<{
  interruptTimeoutMs: number;
  releaseTimeoutMs: number;
  cutoffAtMs?: number;
}>;

/** The server-minted scope a launch was authorized under. */
export type ServerLaunchIdentity = Readonly<{
  requestId: string;
  controlEpoch: number;
  launchId: string;
}>;

/** What a launch is handed: the launch itself, less what only the provider is asked with, plus
 * the server-minted scope it was authorized under. */
export type AgentProcessStartOptions = Omit<AgentLaunchInput, "agentId" | "config"> & {
  /** The already-authorized launch identity to remember only if the runtime starts. */
  serverLaunch?: ServerLaunchIdentity;
};

export type { CodeAgentProviderFactory } from "@lrm/coforge-anvil";

/** Owns Agent availability and runtime processes for one supervised Workspace. */
export class AgentProcessManager {
  readonly #createProvider: CodeAgentProviderFactory;
  readonly #resolveGitHooks: typeof resolveGitHookInjectionForLaunch;
  readonly #runtimes = new Map<string, AgentRuntime>();
  readonly #restartConfigs = new Map<string, AgentRestartConfig>();
  readonly #states = new Map<string, AgentStateMachine>();
  /** How far this Agent's teardown got; see `AgentTeardown`. */
  readonly #teardown = new Map<string, AgentTeardown>();
  readonly #stops = new Map<string, Promise<void>>();
  /** Releases in flight (`release`), which a `stop` waits out before stopping. */
  readonly #releases = new Map<string, Promise<void>>();
  /** The Activity `clientSeq` last sent for this Agent. Kept in its own map,
   * separate from `AgentRestartConfig`, because `start()` replaces that whole entry on every
   * call and this counter must survive that replacement to let a woken launch continue it
   * instead of restarting at 0 under a reused `launchId` — the server's Activity idempotency key
   * is `(agentId, launchId, clientSeq)` (docs/observability/activity-delivery-and-errors.md). Cleared alongside the restart
   * config on `stop()`/`shutdown()`. */
  readonly #launchClientSeq = new Map<string, number>();

  constructor(
    createProvider: CodeAgentProviderFactory,
    resolveGitHooks: typeof resolveGitHookInjectionForLaunch = resolveGitHookInjectionForLaunch,
    private readonly conversationStore?: (agentId: string) => ConversationSessionStore,
    private readonly contextViewRequestLogDirectory?: (agentId: string) => string,
  ) {
    this.#createProvider = createProvider;
    this.#resolveGitHooks = resolveGitHooks;
  }

  get size(): number {
    return this.#runtimes.size;
  }

  status(agentId: string): AgentStatus {
    return this.#stateFor(agentId).state;
  }

  async start(
    agentId: string,
    config: AgentRuntimeConfig,
    options: AgentProcessStartOptions,
  ): Promise<AgentRuntime> {
    const { sessionId, serverLaunch } = options;
    const teardown = this.#teardown.get(agentId);
    if (teardown === "stopping") {
      throw new Error(`Agent runtime is stopping: ${agentId}`);
    }
    if (teardown !== undefined && UNCLEARED.has(teardown)) {
      // One Agent never has two processes, so a Start clears what the failed teardown left
      // before it launches anything: confirmed gone, it proceeds; still there, it is refused
      // with the runtime's own reason and the next click tries again (task #705).
      await this.#reclaim(agentId);
    } else if (this.#runtimes.has(agentId)) {
      throw new Error(`Agent runtime is already active: ${agentId}`);
    }
    const requestLogDirectory = this.contextViewRequestLogDirectory?.(agentId);
    const launch: AgentLaunchInput = {
      config,
      ...options,
      agentId,
      ...(requestLogDirectory ? { contextViewRequestLogDirectory: requestLogDirectory } : {}),
    };
    const ports: AgentLaunchPreparationPorts = {
      createProvider: this.#createProvider,
      resolveGitHooks: this.#resolveGitHooks,
      ...(this.conversationStore ? { conversationStore: this.conversationStore } : {}),
    };
    const sessionOptions = await prepareAgentLaunch(launch, ports);
    let session: AgentSession;
    try {
      session = await createAgentSession(launch, sessionOptions, ports);
    } catch (error) {
      // A launch that died in its own teardown leaves a retryable mark, not a permanent one:
      // the next Start re-clears the tree it left (task #705).
      if (error instanceof AgentProcessCleanupError) this.#teardown.set(agentId, "failed");
      throw error;
    }
    const runtime: AgentRuntime = Object.freeze({ config, session });
    this.#restartConfigs.set(agentId, {
      config,
      sessionId,
      ...(serverLaunch ? { serverLaunch } : {}),
    });
    this.#stateFor(agentId).transition("runtime_ready");
    this.#runtimes.set(agentId, runtime);
    session.onExit((exit) => {
      if (this.#runtimes.get(agentId)?.session !== session) return;
      // An in-flight Stop or release owns this Agent's state: its own path records the outcome.
      if (this.#teardown.get(agentId) === "stopping") return;
      if (exit?.cleanupUnconfirmed === true) {
        // The end is real but the tree under it may not be: stay registered and retryable, so
        // the next Start collects that tree before it launches anything (task #704, #705).
        this.#teardown.set(agentId, "exit-failed");
        return;
      }
      // A clean end settles a failed one: the process this Agent could not confirm gone is gone.
      this.#teardown.delete(agentId);
      this.#forgetRuntime(agentId, session);
    });
    return runtime;
  }

  /**
   * Ends the Agent's process but keeps what a later wake needs: its restart config, server launch
   * identity and Activity `clientSeq`. The Agent reports stopping until the process has exited.
   * Rejects, leaving the runtime registered, when the process does not exit within `timeoutMs`.
   */
  async release(
    agentId: string,
    timeoutMs: number,
    options?: Readonly<{ cutoffAtMs?: number }>,
  ): Promise<void> {
    const runtime = this.#runtimes.get(agentId);
    if (!runtime) return;
    if (this.#teardown.get(agentId) === "stopping")
      throw new Error(`Agent runtime is stopping: ${agentId}`);
    this.#teardown.set(agentId, "stopping");
    const releasing = (async () => {
      try {
        await withDeadline(
          runtime.session.dispose(options),
          timeoutMs,
          () => new Error(`Agent runtime did not exit in time: ${agentId}`),
        );
        this.#forgetRuntime(agentId, runtime.session);
      } finally {
        // A release that failed claims nothing about the tree: the runtime stays registered and
        // this session keeps delivering, so only a real Stop settles its process (task #705).
        if (this.#teardown.get(agentId) === "stopping") this.#teardown.delete(agentId);
      }
    })();
    this.#releases.set(agentId, releasing);
    try {
      await releasing;
    } finally {
      this.#releases.delete(agentId);
    }
  }

  /**
   * Stops only the current turn when the provider's native interrupt settles. If it does not
   * settle within the bounded window, release the provider process while retaining its restart
   * configuration so the next message can resume the session. An idle or absent runtime is not a
   * turn to interrupt.
   */
  async interruptTurn(
    agentId: string,
    options: AgentTurnInterruptOptions,
  ): Promise<AgentTurnInterruptResult> {
    if (
      this.#teardown.get(agentId) === "stopping" ||
      this.#releases.has(agentId) ||
      this.#stops.has(agentId)
    )
      return "not_running";
    const runtime = this.#runtimes.get(agentId);
    if (!runtime) return "not_running";
    if (runtime.session.hasLiveTurn === false) return "not_running";
    let unsubscribe = () => {};
    try {
      const turnEnded = new Promise<void>((resolve) => {
        unsubscribe = runtime.session.subscribe((event) => {
          if (event.type === "completed") resolve();
        });
      });
      await withDeadline(
        Promise.all([runtime.session.interrupt(), turnEnded]).then(() => undefined),
        options.interruptTimeoutMs,
        () => new Error(`Agent turn interrupt timed out: ${agentId}`),
      );
      // Raft's killTurnProcesses: the native interrupt ended the turn but left the process
      // running, so the descendants it spawned are still alive. Kill only those, bounded by the
      // same turn fence the restart path uses; best-effort, never fails the interrupt itself.
      if (options.cutoffAtMs !== undefined)
        await runtime.session
          .killTurnProcesses?.({
            startedAfterMs: options.cutoffAtMs,
            startedBeforeMs: processClockMs(),
          })
          .catch(() => undefined);
      return "interrupted";
    } catch {
      try {
        await this.release(agentId, options.releaseTimeoutMs, { cutoffAtMs: options.cutoffAtMs });
      } catch {
        // Cleanup has already attempted its graceful and forced ladder; preserve the bounded
        // fallback result so the request does not leak an exception to the Web caller.
      }
      return "restarted";
    } finally {
      unsubscribe();
    }
  }

  /**
   * Stops one provider task by its `subagent-progress` task id, leaving the turn and the
   * process running — Raft's `interruptSubagent`. `"unsupported"` when the session has no
   * per-task stop; `"not_running"` when the Agent or task is already gone.
   */
  async interruptSubagent(
    agentId: string,
    taskId: string,
  ): Promise<"interrupted" | "not_running" | "unsupported"> {
    if (
      this.#teardown.get(agentId) === "stopping" ||
      this.#releases.has(agentId) ||
      this.#stops.has(agentId)
    )
      return "not_running";
    const runtime = this.#runtimes.get(agentId);
    if (!runtime) return "not_running";
    const stop = runtime.session.interruptSubagent;
    if (!stop) return "unsupported";
    return stop.call(runtime.session, taskId);
  }

  stop(agentId: string): Promise<void> {
    const existing = this.#stops.get(agentId);
    if (existing) return existing;
    const stopping = this.#stop(agentId).finally(() => this.#stops.delete(agentId));
    this.#stops.set(agentId, stopping);
    return stopping;
  }

  async #stop(agentId: string): Promise<void> {
    // A stop overrides a release in flight: it waits that out, then forgets the Agent as usual.
    const releasing = this.#releases.get(agentId);
    if (releasing) await releasing.catch(() => {});
    if (this.#teardown.get(agentId) === "stopping")
      throw new Error(`Agent runtime is stopping: ${agentId}`);
    const runtime = this.#runtimes.get(agentId);
    if (!runtime) {
      this.#restartConfigs.delete(agentId);
      this.#launchClientSeq.delete(agentId);
      this.#stateFor(agentId).transition("deactivate");
      return;
    }
    const uncleared = this.#teardown.get(agentId);
    this.#teardown.set(agentId, "stopping");
    try {
      await runtime.session.dispose();
      // A dispose that resolves proves nothing when an earlier teardown could not confirm exit:
      // that tree is only settled by the process table (task #704, #705).
      if (uncleared !== undefined && UNCLEARED.has(uncleared)) await confirmGone(agentId);
    } catch (error) {
      // A Stop that cannot confirm exit is retryable, and its next Start re-clears the tree
      // first; leaving it marked stopping muted the Agent forever (task #705).
      if (this.#teardown.get(agentId) === "stopping") this.#teardown.set(agentId, "failed");
      throw error;
    }
    // A confirmed stop settles every mark this Agent had, including an earlier uncleared one.
    this.#teardown.delete(agentId);
    this.#forgetRuntime(agentId, runtime.session);
    this.#restartConfigs.delete(agentId);
    this.#launchClientSeq.delete(agentId);
    this.#stateFor(agentId).transition("deactivate");
  }

  /** The Agent's session, unless a teardown could not confirm its process exited: that session is
   * not a runtime anyone may treat as up. This accessor answers the daemon's liveness questions
   * (does a Start need to launch, may a stale record be repaired), and both must see "not running"
   * so the next Start re-clears that tree first (#705). A failed release keeps delivering. */
  session(agentId: string): AgentSession | undefined {
    const teardown = this.#teardown.get(agentId);
    if (teardown !== undefined && UNCLEARED.has(teardown)) return undefined;
    const runtime = this.#runtimes.get(agentId);
    return runtime?.session;
  }

  runtime(agentId: string): AgentRuntime | undefined {
    return this.#runtimes.get(agentId);
  }

  restartConfig(agentId: string): AgentRestartConfig | undefined {
    return this.#restartConfigs.get(agentId);
  }

  /** Rebinds the server's launch identity on an existing Agent's restart config.
   * A no-op when there is no restart config to attach it to (the Agent is not currently
   * running/wakeable) — there is nothing for a later wake to read it back from anyway. */
  rememberServerLaunch(agentId: string, serverLaunch: ServerLaunchIdentity): void {
    const existing = this.#restartConfigs.get(agentId);
    if (!existing) return;
    this.#restartConfigs.set(agentId, { ...existing, serverLaunch });
  }

  serverLaunch(agentId: string): ServerLaunchIdentity | undefined {
    return this.#restartConfigs.get(agentId)?.serverLaunch;
  }

  /** Drops the wake config a terminal launch failure must not keep: with it gone, deliveries
   * and App Inbox notices find no restart to wake and wait for the offline record's custody
   * and a person's Start, matching the reference Computer's terminal-failure residency. */
  forgetRestart(agentId: string): void {
    this.#restartConfigs.delete(agentId);
    this.#launchClientSeq.delete(agentId);
  }

  /** Replaces the runtime fields of the wake config, keeping everything else a launch put there
   * (tool profile, Memory flag, variables, Session, server launch identity). `fields` is complete:
   * an optional one it leaves out is removed, not kept. A live runtime is frozen and unchanged: this only
   * changes what the next launch uses. A no-op without a restart config. */
  replaceRestartRuntime(agentId: string, fields: RestartRuntimeFields): void {
    const existing = this.#restartConfigs.get(agentId);
    if (!existing) return;
    const {
      modelProvider: _modelProvider,
      providerConfig: _providerConfig,
      fastMode: _fastMode,
      ...kept
    } = existing.config;
    this.#restartConfigs.set(agentId, { ...existing, config: { ...kept, ...fields } });
  }

  /** Drops the remembered resume pointer once its Session was invalidated, so the next wake
   * cannot ask the provider for a Session that no longer exists. The config and server launch
   * identity stay: only the native Session reference is gone. */
  clearRestartSession(agentId: string): void {
    const existing = this.#restartConfigs.get(agentId);
    if (existing && existing.sessionId !== undefined)
      this.#restartConfigs.set(agentId, { ...existing, sessionId: undefined });
  }

  /** Records the Activity `clientSeq` just sent for this Agent, so a later wake under the same
   * (remembered) `launchId` can continue from it instead of restarting at 0. */
  recordClientSeq(agentId: string, clientSeq: number): void {
    this.#launchClientSeq.set(agentId, clientSeq);
  }

  lastClientSeq(agentId: string): number {
    return this.#launchClientSeq.get(agentId) ?? 0;
  }

  activeAgentIds(): string[] {
    return [...this.#restartConfigs.keys()];
  }

  runningAgentIds(): string[] {
    return [...this.#runtimes.keys()];
  }

  /** Whether a teardown for this Agent is in flight. */
  isStopping(agentId: string): boolean {
    return this.#teardown.get(agentId) === "stopping";
  }

  /** Whether this Agent's last teardown could not confirm its process exited. It is not
   * stopping: it can be stopped again, and its next Start re-clears that tree first. */
  stopFailed(agentId: string): boolean {
    const teardown = this.#teardown.get(agentId);
    return teardown !== undefined && UNCLEARED.has(teardown);
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.#runtimes.keys()].map((agentId) => this.stop(agentId)));
    this.#teardown.clear();
    this.#restartConfigs.clear();
    this.#launchClientSeq.clear();
    for (const state of this.#states.values()) state.transition("deactivate");
  }

  /**
   * Clears what a failed teardown left before a replacement launch: the processes its launch tag
   * names, and the session still held. Resolves only once nothing of the old launch is left;
   * otherwise it throws the runtime's own reason and keeps the mark, so the Start is refused
   * rather than run beside it (task #705).
   */
  async #reclaim(agentId: string): Promise<void> {
    const runtime = this.#runtimes.get(agentId);
    // A dispose that resolves proves nothing for an exit that said its tree survived: that tree
    // stays, and only a process-table kill can settle it (#704). Both paths therefore decide on
    // the sweep, which spares no token, so the failed launch's own processes are collected.
    if (runtime) await runtime.session.dispose().catch(throwStopFailure);
    await confirmGone(agentId);
    if (runtime) this.#forgetRuntime(agentId, runtime.session);
    this.#teardown.delete(agentId);
  }

  /** Forgets a runtime whose session is the one that just ended. Another launch's is left alone. */
  #forgetRuntime(agentId: string, session: AgentSession): void {
    if (this.#runtimes.get(agentId)?.session !== session) return;
    this.#runtimes.delete(agentId);
    this.#stateFor(agentId).transition("runtime_released");
  }

  #stateFor(agentId: string): AgentStateMachine {
    const existing = this.#states.get(agentId);
    if (existing) return existing;
    const machine = new AgentStateMachine();
    this.#states.set(agentId, machine);
    return machine;
  }
}
