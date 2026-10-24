import { getLogger } from "@logtape/logtape";
import { isMemoryAgentRuntime } from "@coforge/agent";
import { AGENT_ACTIVITY_DETAIL_KIND, thrownMessage } from "@lrm/coforge-sdk/internal";
import type { AgentSession } from "@lrm/coforge-anvil";
import type { AgentRestartConfig, AgentRuntime } from "#src/agent-runtime/agent-process-manager";
import type { OutstandingBackgroundTasks } from "#src/agent-runtime/subagent-progress-activity";
import type { ToolCallLedger } from "#src/agent-runtime/tool-call-ledger";
import {
  describeRecycledSession,
  type ColdIdleStop,
} from "#src/agent-runtime/wake-session-recycle";
import { runtimeDisplayName } from "./session-invalidate-activity";
import { idleBlocker, type AgentIdleFacts, type ColdIdleAgent } from "./cold-idle-sweep";
import {
  STALLED_RECOVERY_EXIT_TIMEOUT_MS,
  shouldRecoverStalledRuntime,
  type ProviderProgress,
} from "./stalled-recovery";

const logger = getLogger(["coforge", "daemon", "runtime"]);

/** What ending a live runtime needs of the Agent's current launch. */
export type ReleasableLaunch = {
  /** Mutes the launch's Activity down to its final frames. */
  stopping: boolean;
  /** When the provider last reported anything; cleared when ending fails, so the launch is never
   * judged again. */
  progress?: ProviderProgress;
  toolCalls?: ToolCallLedger;
  backgroundTasks?: OutstandingBackgroundTasks;
};

/** A launch found stalled, and what its restart needs. */
export type StalledRuntime<L extends ReleasableLaunch> = Readonly<{
  launch: L;
  session: AgentSession;
  restart: AgentRestartConfig;
  silentForMs: number;
}>;

/** Why a live runtime is ended, what is announced, and what is logged on either outcome. */
type RuntimeReleasePlan = Readonly<{
  announce: Readonly<{ detailKind: string; text: string }>;
  /** Logged once the announcement is out. */
  log: () => void;
  failure: Readonly<{ text: string; message: string; event: string }>;
  /** What happens once the runtime is down. */
  wake: Readonly<{
    /** Wake only an Agent with deliveries or app items kept for its next launch. */
    onlyIfParked: boolean;
    /** The caller waits for the launch, rather than going on while it runs. */
    awaited: boolean;
    /** Logged when the relaunch fails. */
    failure: Readonly<{ message: string; event: string }>;
  }>;
}>;

export type RuntimeReleasePorts<L extends ReleasableLaunch> = Readonly<{
  /** The Agent's current launch. */
  launch(agentId: string): L | undefined;
  runtime(agentId: string): AgentRuntime | undefined;
  restartConfig(agentId: string): AgentRestartConfig | undefined;
  /** The launch of the Agent's last busy Activity, while it has one. */
  lastBusyLaunch(agentId: string): L | undefined;
  /** The session reported to the cloud can be resumed by a relaunch. */
  resumable(agentId: string): boolean;
  /** The native session this runtime last reported. */
  sessionId(agentId: string): string | undefined;
  /** An explicit Stop is under way, so nothing may relaunch. */
  isStopping(agentId: string): boolean;
  /** The idle evidence only the runtime holds. */
  daemonIdleFacts(
    agentId: string,
  ): Pick<
    AgentIdleFacts,
    | "working"
    | "deliveriesQueued"
    | "inputsQueued"
    | "launching"
    | "stopping"
    | "runnerHold"
    | "migrating"
  >;
  /** Messages or app-item notices kept for the Agent's next launch while its runtime was ending. */
  hasParkedWork(agentId: string): boolean;
  /** The runtime stayed up: presents what was kept as it would at a turn's end. */
  flushParked(agentId: string): void;
  /** Launches the Agent again from its remembered restart config. */
  wake(agentId: string, restart: AgentRestartConfig): Promise<unknown>;
  /** Publishes an Activity for `launch`. */
  publish(
    agentId: string,
    launch: L,
    level: "info" | "error",
    detailKind: string,
    text: string,
  ): void;
  /** Hands the old turn's tracked mentions back as unknown before the process goes. */
  handBackMentions(agentId: string): Promise<void>;
  /** Ends the process but keeps what a later wake needs. */
  release(agentId: string, timeoutMs: number): Promise<void>;
}>;

/**
 * Ends an Agent's live process without a stopped/crashed Activity, so the Agent stays active and
 * wakeable: a stalled provider restarted for a waiting message, or a cold idle runtime stopped by
 * the sweep. While one is under way, arriving messages wait for the next launch.
 */
export class RuntimeRelease<L extends ReleasableLaunch> {
  readonly #ports: RuntimeReleasePorts<L>;
  readonly #recovering = new Set<string>();

  constructor(ports: RuntimeReleasePorts<L>) {
    this.#ports = ports;
  }

  /** Whether the Agent's runtime is being ended; messages meanwhile wait for the relaunch. */
  isRecovering(agentId: string): boolean {
    return this.#recovering.has(agentId);
  }

  /** What a stalled-provider restart works on, when a message arriving now should restart this
   * Agent's provider (`stalled-recovery.ts`): its busy turn has been silent too long with nothing
   * still running. */
  stalled(agentId: string): StalledRuntime<L> | undefined {
    const launch = this.#ports.launch(agentId);
    const session = this.#ports.runtime(agentId)?.session;
    const restart = this.#ports.restartConfig(agentId);
    const progress = launch?.progress;
    if (!launch || !progress || !session || !restart) return undefined;
    const stalled = shouldRecoverStalledRuntime({
      turnBusy: this.#ports.lastBusyLaunch(agentId) === launch && session.hasLiveTurn !== false,
      silentForMs: progress.silentForMs(),
      hasOpenToolCall: launch.toolCalls?.hasOpenToolCall ?? false,
      resumable: this.#ports.resumable(agentId),
    });
    return stalled ? { launch, session, restart, silentForMs: progress.silentForMs() } : undefined;
  }

  /**
   * Restarts a stalled provider for the message(s) now waiting for it, as the reference client
   * does: announce it, end the stalled process without a stopped/crashed Activity, then wake the
   * Agent on the same launch, resuming the session it last reported. Messages meanwhile wait for
   * the relaunch.
   */
  async recoverStalled(agentId: string, stalled: StalledRuntime<L>): Promise<void> {
    const { launch, session, restart, silentForMs } = stalled;
    await this.#endAndWake(
      agentId,
      launch,
      session,
      stalledRuntimePlan(restart, agentId, silentForMs),
    );
  }

  /** The Agent as the cold idle sweep judges it: the daemon's own evidence that it is idle. */
  coldIdleAgent(agentId: string): ColdIdleAgent | undefined {
    const runtime = this.#ports.runtime(agentId);
    if (!runtime) return undefined;
    const launch = this.#ports.launch(agentId);
    const facts = this.#ports.daemonIdleFacts(agentId);
    const busyReason = idleBlocker({
      ...facts,
      memoryAgent: isMemoryAgentRuntime(runtime.config),
      launched: launch?.progress !== undefined && launch.toolCalls !== undefined,
      hasLiveTurn: runtime.session.hasLiveTurn,
      openToolCall: launch?.toolCalls?.hasOpenToolCall ?? false,
      backgroundTasks: launch?.backgroundTasks?.count ?? 0,
      recoveringStalledRuntime: this.#recovering.has(agentId),
      stopping: launch?.stopping === true || facts.stopping,
    });
    return {
      agentId,
      provider: runtime.config.provider,
      envVars: runtime.config.envVars,
      busyReason,
      sessionId: this.#ports.sessionId(agentId),
      lastEventAtMs: launch?.progress?.lastEventAtMs,
    };
  }

  /** Ends a cold idle runtime. A message that arrives meanwhile waits for a launch, which this
   * then performs: the Agent is never left with a delivery and no process. */
  async stopColdIdle(stop: ColdIdleStop): Promise<void> {
    const { agentId } = stop;
    const launch = this.#ports.launch(agentId);
    const session = this.#ports.runtime(agentId)?.session;
    const restart = this.#ports.restartConfig(agentId);
    if (!launch || !session || !restart) return;
    await this.#endAndWake(agentId, launch, session, coldIdleRuntimePlan(restart, stop));
  }

  /** Ends the runtime, then wakes the Agent on its remembered restart config, resuming the
   * session it last reported. A relaunch that fails reports its own launch error; the waiting
   * messages stay queued, acknowledged, for the Agent's next launch. */
  async #endAndWake(
    agentId: string,
    launch: L,
    session: AgentSession,
    plan: RuntimeReleasePlan,
  ): Promise<void> {
    this.#recovering.add(agentId);
    try {
      if (!(await this.#end(agentId, launch, session, plan))) return;
      // A Stop that arrived meanwhile wins, and its config, not the one read before, is current.
      const current = this.#ports.restartConfig(agentId);
      if (this.#ports.isStopping(agentId) || !current) return;
      if (plan.wake.onlyIfParked && !this.#ports.hasParkedWork(agentId)) return;
      const sessionId = this.#ports.sessionId(agentId) ?? current.sessionId;
      // From here a message joins the wake launch as any other does.
      this.#recovering.delete(agentId);
      const woken = this.#ports.wake(agentId, { ...current, sessionId }).catch((error: unknown) =>
        logger.error(plan.wake.failure.message, {
          event: plan.wake.failure.event,
          agent_id: agentId,
          error: thrownMessage(error),
        }),
      );
      if (plan.wake.awaited) await woken;
    } finally {
      this.#recovering.delete(agentId);
    }
  }

  /** False, with an error Activity, when the process will not exit. Once is enough: that launch
   * is never judged again. */
  async #end(
    agentId: string,
    launch: L,
    session: AgentSession,
    plan: RuntimeReleasePlan,
  ): Promise<boolean> {
    // Before `stopping`, which mutes everything but stopped/interrupted/error Activity.
    this.#ports.publish(agentId, launch, "info", plan.announce.detailKind, plan.announce.text);
    plan.log();
    launch.stopping = true;
    try {
      // Dispose can reject notices still waiting for provider acceptance. Hand their mentions
      // back first, before those rejections can settle them as lost.
      await this.#ports.handBackMentions(agentId);
      await this.#ports.release(agentId, STALLED_RECOVERY_EXIT_TIMEOUT_MS);
      return true;
    } catch (error) {
      launch.progress = undefined;
      // A process that is still running gets its Activity back.
      const stillRunning = this.#ports.runtime(agentId)?.session === session;
      if (stillRunning) {
        launch.stopping = false;
        // What arrived meanwhile was kept for a launch that is not coming. It goes to this
        // process, so the runtime must stop reading as ending first, or it is kept again.
        this.#recovering.delete(agentId);
        this.#ports.flushParked(agentId);
      }
      this.#ports.publish(
        agentId,
        launch,
        "error",
        AGENT_ACTIVITY_DETAIL_KIND.RUNTIME_ERROR,
        plan.failure.text,
      );
      logger.error(plan.failure.message, {
        event: plan.failure.event,
        agent_id: agentId,
        still_running: stillRunning,
        error: thrownMessage(error),
      });
      return false;
    }
  }
}

function stalledRuntimePlan(
  restart: AgentRestartConfig,
  agentId: string,
  silentForMs: number,
): RuntimeReleasePlan {
  const runtimeName = runtimeDisplayName(restart.config.provider);
  return {
    announce: {
      detailKind: AGENT_ACTIVITY_DETAIL_KIND.STALLED_RECOVERY,
      text: `Restarting stalled ${runtimeName} runtime for queued message`,
    },
    log: () =>
      logger.warn("Agent runtime stalled; restarting it for a queued message", {
        event: "agent.runtime.stalled_recovery",
        agent_id: agentId,
        silent_for_ms: silentForMs,
      }),
    failure: {
      text: `Restarting the stalled ${runtimeName} runtime failed`,
      message: "Agent stalled-runtime restart failed",
      event: "agent.runtime.stalled_recovery_failed",
    },
    wake: {
      onlyIfParked: false,
      awaited: true,
      failure: {
        message: "Agent stalled-runtime relaunch failed",
        event: "agent.runtime.stalled_recovery_failed",
      },
    },
  };
}

function coldIdleRuntimePlan(restart: AgentRestartConfig, stop: ColdIdleStop): RuntimeReleasePlan {
  const runtimeName = runtimeDisplayName(restart.config.provider);
  return {
    announce: {
      detailKind: AGENT_ACTIVITY_DETAIL_KIND.IDLE,
      text: `Stopped idle ${runtimeName} runtime (${describeRecycledSession(stop.idleMs, stop.priorContextTokens)}) to free memory; it restarts on the next message`,
    },
    log: () =>
      logger.info("Agent cold idle runtime stopped", {
        event: "agent.runtime.cold_idle_stop",
        agent_id: stop.agentId,
        session_id: stop.sessionId,
        idle_ms: stop.idleMs,
        prior_context_tokens: stop.priorContextTokens,
      }),
    failure: {
      text: `Stopping the idle ${runtimeName} runtime failed`,
      message: "Agent cold idle stop failed",
      event: "agent.runtime.cold_idle_stop_failed",
    },
    wake: {
      onlyIfParked: true,
      awaited: false,
      failure: {
        message: "Agent cold idle relaunch failed",
        event: "agent.runtime.cold_idle_wake_failed",
      },
    },
  };
}
