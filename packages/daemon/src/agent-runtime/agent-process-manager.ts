import { AgentStateMachine, type AgentStatus } from "./agent-state-machine";
import {
  MemoryConversationSessions,
  type ConversationSessionStore,
} from "./memory-conversation-sessions";
import type { AgentRuntimeConfig, AgentSession, AgentSessionOptions } from "@coforge/agent";
import type { CodeAgentProviderFactory } from "#src/code-agent/contract";
import { AgentProcessCleanupError } from "#src/code-agent/contract";
import { withDeadline } from "#src/code-agent/deadline";
import {
  buildCoforgeAgentInstructions,
  type AgentLaunchIdentity,
} from "#src/code-agent/agent-instructions";
import { installAssignedSkills, type AssignedSkillPack } from "#src/code-agent/assigned-skills";
import { agentEnvironment } from "#src/code-agent/environment";
import { resolveGitHookInjectionForLaunch } from "#src/code-agent/git-hooks";
import { seedAgentMemory } from "./agent-memory-seed";
import { isMemoryAgentToolProfile } from "@lrm/coforge-sdk/agent";
import { isMemoryAgentRuntime, evalDisablesHostPiInjection } from "@coforge/agent";
import { mkdir } from "node:fs/promises";

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

export type { CodeAgentProviderFactory } from "#src/code-agent/contract";
/** Owns Agent availability and runtime processes for one supervised Workspace. */
export class AgentProcessManager {
  readonly #createProvider: CodeAgentProviderFactory;
  readonly #resolveGitHooks: typeof resolveGitHookInjectionForLaunch;
  readonly #runtimes = new Map<string, AgentRuntime>();
  readonly #restartConfigs = new Map<string, AgentRestartConfig>();
  readonly #states = new Map<string, AgentStateMachine>();
  readonly #stopping = new Set<string>();
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
    const {
      agentWorkspaceDirectory,
      sessionId,
      environment,
      runtimeId,
      onSessionId,
      sessionMode,
      assignedSkillPacks = [],
      identity,
      serverLaunch,
    } = options;
    if (this.#stopping.has(agentId)) {
      throw new Error(`Agent runtime is stopping: ${agentId}`);
    }
    if (this.#runtimes.has(agentId)) {
      throw new Error(`Agent runtime is already active: ${agentId}`);
    }
    await mkdir(agentWorkspaceDirectory, { recursive: true, mode: 0o700 });
    const disableHostPiInjection =
      isMemoryAgentToolProfile(config.toolProfile) ||
      evalDisablesHostPiInjection(environment) ||
      evalDisablesHostPiInjection();
    if (!disableHostPiInjection) {
      await seedAgentMemory(agentWorkspaceDirectory, {
        name: identity?.name,
        displayName: identity?.displayName,
        description: identity?.description,
      });
      if (assignedSkillPacks.length > 0) {
        await installAssignedSkills({
          provider: config.provider,
          agentWorkspaceDirectory,
          packs: assignedSkillPacks,
        });
      }
    }
    // Probed against the same PATH the Agent's own git calls will search.
    const gitHooks = await this.#resolveGitHooks(
      agentEnvironment(environment, Bun.env, process.platform, { envVars: config.envVars }).PATH,
    );
    let session: AgentSession;
    try {
      const provider = this.#createProvider(config.provider);
      const options: AgentSessionOptions = {
        agentId,
        ...(runtimeId ? { runtimeId } : {}),
        agentWorkspaceDirectory,
        ...(isMemoryAgentRuntime(config) ? { memoryControlSession: true } : {}),
        instructions: buildCoforgeAgentInstructions({
          agentWorkspaceDirectory,
          agentId,
          identity,
          toolProfile: config.toolProfile,
        }),
        sessionId,
        sessionMode,
        onSessionId,
        runtime: config,
        environment,
        gitHooks,
      };
      session = await provider.createAgentSession(options);
      if (isMemoryAgentRuntime(config))
        session = new MemoryConversationSessions({
          primary: session,
          options,
          create: (options) => provider.createAgentSession(options),
          store: this.conversationStore?.(agentId),
        });
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
    session.onExit(() => {
      if (this.#runtimes.get(agentId)?.session !== session) return;
      if (this.#stopping.has(agentId)) return;
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
  async release(agentId: string, timeoutMs: number): Promise<void> {
    const runtime = this.#runtimes.get(agentId);
    if (!runtime) return;
    if (this.#stopping.has(agentId)) throw new Error(`Agent runtime is stopping: ${agentId}`);
    this.#stopping.add(agentId);
    const releasing = (async () => {
      try {
        await withDeadline(
          runtime.session.dispose(),
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

  async stop(agentId: string): Promise<void> {
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
