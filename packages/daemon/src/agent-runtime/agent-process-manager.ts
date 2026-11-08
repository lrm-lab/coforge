import { AgentStateMachine, type AgentStatus } from "./agent-state-machine";
import type { AgentRuntimeConfig, AgentSession, AgentSessionOptions } from "@coforge/agent";
import type { CodeAgentProviderFactory } from "@lrm/coforge-anvil";
import { AgentProcessCleanupError, withDeadline } from "@lrm/coforge-anvil";
import {
  createAgentSession,
  prepareAgentLaunch,
  type AgentLaunchInput,
} from "./agent-launch-preparation";
import type { ConversationSessionStore } from "./memory-conversation-sessions";
import type { AgentLaunchIdentity } from "#src/code-agent/agent-instructions";
import type { AssignedSkillPack } from "#src/code-agent/assigned-skills";
import { resolveGitHookInjectionForLaunch } from "#src/code-agent/git-hooks";
import { processClockMs } from "#src/platform/process-tree";

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

export type AgentProcessStartOptions = Pick<
  AgentSessionOptions,
  | "agentWorkspaceDirectory"
  | "sessionId"
  | "environment"
  | "runtimeId"
  | "onSessionId"
  | "sessionMode"
> & {
  assignedSkillPacks?: readonly AssignedSkillPack[];
  /** Server-authored Agent identity for the standing prompt. */
  identity?: AgentLaunchIdentity;
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
  readonly #stopping = new Set<string>();
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
    if (this.#stopping.has(agentId)) {
      throw new Error(`Agent runtime is stopping: ${agentId}`);
    }
    if (this.#runtimes.has(agentId)) {
      throw new Error(`Agent runtime is already active: ${agentId}`);
    }
    const launch: AgentLaunchInput = { config, ...options, agentId };
    const ports = {
      createProvider: this.#createProvider,
      resolveGitHooks: this.#resolveGitHooks,
      ...(this.conversationStore ? { conversationStore: this.conversationStore } : {}),
    };
    const { options: sessionOptions } = await prepareAgentLaunch(launch, ports);
    let session: AgentSession;
    try {
      session = await createAgentSession(launch, sessionOptions, ports);
    } catch (error) {
      if (error instanceof AgentProcessCleanupError) this.#stopping.add(agentId);
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
      // A tree that survived its teardown may still be running: the end is reported, but the
      // runtime stays registered so nothing replaces a process that was never killed (#704).
      if (this.#stopping.has(agentId) || exit?.cleanupUnconfirmed === true) return;
      this.#runtimes.delete(agentId);
      this.#stateFor(agentId).transition("runtime_released");
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
    if (this.#stopping.has(agentId)) throw new Error(`Agent runtime is stopping: ${agentId}`);
    this.#stopping.add(agentId);
    const releasing = (async () => {
      try {
        await withDeadline(
          runtime.session.dispose(options),
          timeoutMs,
          () => new Error(`Agent runtime did not exit in time: ${agentId}`),
        );
        if (this.#runtimes.get(agentId)?.session === runtime.session) {
          this.#runtimes.delete(agentId);
          this.#stateFor(agentId).transition("runtime_released");
        }
      } finally {
        this.#stopping.delete(agentId);
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
    if (this.#stopping.has(agentId) || this.#releases.has(agentId) || this.#stops.has(agentId))
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
    if (this.#stopping.has(agentId) || this.#releases.has(agentId) || this.#stops.has(agentId))
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
    if (this.#stopping.has(agentId)) throw new Error(`Agent runtime is stopping: ${agentId}`);
    const runtime = this.#runtimes.get(agentId);
    if (!runtime) {
      this.#restartConfigs.delete(agentId);
      this.#launchClientSeq.delete(agentId);
      this.#stateFor(agentId).transition("deactivate");
      return;
    }
    this.#stopping.add(agentId);
    await runtime.session.dispose();
    if (this.#runtimes.get(agentId)?.session === runtime.session) this.#runtimes.delete(agentId);
    this.#stopping.delete(agentId);
    this.#restartConfigs.delete(agentId);
    this.#launchClientSeq.delete(agentId);
    this.#stateFor(agentId).transition("deactivate");
  }

  session(agentId: string): AgentSession | undefined {
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

  isStopping(agentId: string): boolean {
    return this.#stopping.has(agentId);
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.#runtimes.keys()].map((agentId) => this.stop(agentId)));
    this.#restartConfigs.clear();
    this.#launchClientSeq.clear();
    for (const state of this.#states.values()) state.transition("deactivate");
  }

  #stateFor(agentId: string): AgentStateMachine {
    const existing = this.#states.get(agentId);
    if (existing) return existing;
    const machine = new AgentStateMachine();
    this.#states.set(agentId, machine);
    return machine;
  }
}
