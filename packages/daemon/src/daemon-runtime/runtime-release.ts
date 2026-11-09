import { getLogger } from "@logtape/logtape";
import { isMemoryAgentRuntime } from "@coforge/agent";
import {
  AGENT_ACTIVITY_DETAIL_KIND,
  thrownMessage,
  type AgentActivityRuntimeError,
} from "@lrm/coforge-sdk/internal";
import type { AgentSession } from "@lrm/coforge-anvil";
import type { AgentRestartConfig, AgentRuntime } from "#src/agent-runtime/agent-process-manager";
import type { OutstandingBackgroundTasks } from "#src/agent-runtime/subagent-progress-activity";
import type { ToolCallLedger } from "#src/agent-runtime/tool-call-ledger";
import type { ColdIdleStop } from "#src/agent-runtime/wake-session-recycle";
import { UnattendedRecoveries, reportUnattendedLimit } from "./stalled-recovery-unattended";
import { logStalledRecovery } from "./agent-failure-logs";
import { idleBlocker, type AgentIdleFacts, type ColdIdleAgent } from "./cold-idle-sweep";
import type { BusyActivity } from "./agent-activity-publisher";
import type { DeliveryHoldReason } from "./agent-delivery-queue";
import type { LaunchRequest } from "./runtime-launch-types";
import {
  coldIdleRuntimePlan,
  configApplyRuntimePlan,
  freshConfigRuntimePlan,
  stalledRuntimePlan,
  type RuntimeReleasePlan,
} from "./runtime-release-plans";
import {
  STALLED_RECOVERY_EXIT_TIMEOUT_MS,
  stalledRecoveryBasis,
  unattendedResumePrompt,
  type ProviderProgress,
  type StalledRecoveryBasis,
} from "./stalled-recovery";

const logger = getLogger(["coforge", "daemon", "runtime"]);

/** Whether the Agent's deliveries are held waiting out a retryable failure. A fingerprint fence
 * holds them too, but that hold does not end on its own, so it must not silence the judgment. */
function heldForRetry(reason: DeliveryHoldReason | undefined): boolean {
  return reason === "rate_limit_backoff" || reason === "runtime_error_backoff";
}

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
  /** Why it was judged stalled, and on which facts (`stalled-recovery.ts`). */
  basis: StalledRecoveryBasis;
}>;

/** What a wake relaunches from: the remembered restart config, and the first turn to give it. */
export type WakeRestart = AgentRestartConfig & Readonly<{ resumePrompt?: string }>;

/** The launch a wake asks for: the session to resume and, when there is one, its first turn. */
export function wakeRequest(restart: WakeRestart): LaunchRequest {
  return {
    sessionId: restart.sessionId,
    ...(restart.resumePrompt !== undefined ? { resumePrompt: restart.resumePrompt } : {}),
  };
}

export type RuntimeReleasePorts<L extends ReleasableLaunch> = Readonly<{
  /** The Agent's current launch. */
  launch(agentId: string): L | undefined;
  runtime(agentId: string): AgentRuntime | undefined;
  restartConfig(agentId: string): AgentRestartConfig | undefined;
  /** The Agent's last busy Activity and its launch, while it has one. */
  lastBusy(agentId: string): BusyActivity<L> | undefined;
  /** How long the Agent's oldest queued delivery has waited, if any is queued. */
  queuedForMs(agentId: string): number | undefined;
  /** Why the Agent's deliveries are explicitly held right now, if they are. */
  explicitHold?(agentId: string): DeliveryHoldReason | undefined;
  /** When the Agent's process last accepted an inbox notice; undefined when none was accepted —
   * the clock for the frozen-after-notice judgment (task #318). */
  noticeAcceptedAt?(agentId: string): number | undefined;
  /** When the Agent last did anything a checked read or an operation counts as. Provider
   * output's clock is the launch's progress, not this. */
  lastAgentActionAt?(agentId: string): number | undefined;
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
  wake(agentId: string, restart: WakeRestart): Promise<unknown>;
  /** Publishes an Activity for `launch`, its draft built from the rest as `activityDraft` does. */
  publish(
    agentId: string,
    launch: L,
    detailKind: string,
    level: "info" | "error",
    text: string,
    extra?: Readonly<{ runtimeError?: AgentActivityRuntimeError }>,
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
  readonly #unattended = new UnattendedRecoveries();

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
    const basis = stalledRecoveryBasis(
      {
        turnBusy: this.#ports.lastBusy(agentId)?.launch === launch && session.hasLiveTurn !== false,
        // A waiting delivery whose submitted turn never began reports no live turn: that is the
        // "queued but no new round started" case, not a turn to wait on.
        liveTurn: session.hasLiveTurn === true,
        silentForMs: progress.silentForMs(),
        queuedForMs: this.#ports.queuedForMs(agentId),
        hasOpenToolCall: launch.toolCalls?.hasOpenToolCall ?? false,
        resumable: this.#ports.resumable(agentId),
        noticeAcceptedForMs: ageOf(this.#ports.noticeAcceptedAt?.(agentId)),
        recoveryHold: heldForRetry(this.#ports.explicitHold?.(agentId)),
        // The running session declares whether a notice can steer its live turn; an adapter
        // that does not declare is read as queue-only (the longer fuse).
        steersBusyTurn: session.steersBusyTurn === true,
        lastAgentActionForMs: Math.min(
          progress.silentForMs(),
          ageOf(this.#ports.lastAgentActionAt?.(agentId)) ?? Number.POSITIVE_INFINITY,
        ),
      },
      { lastEventAtMs: progress.lastEventAtMs },
    );
    return basis ? { launch, session, restart, basis } : undefined;
  }

  /**
   * Restarts a stalled provider for the message(s) now waiting for it, as the reference client
   * does: announce it, end the stalled process without a stopped/crashed Activity, then wake the
   * Agent on the same launch, resuming the session it last reported. Messages meanwhile wait for
   * the relaunch.
   */

  async recoverStalled(
    agentId: string,
    stalled: StalledRuntime<L>,
    options: Readonly<{ unattended?: boolean }> = {},
  ): Promise<void> {
    const { launch, session, restart, basis } = stalled;
    logStalledRecovery(agentId, basis);
    let resumePrompt: string | undefined;
    if (options.unattended) {
      // No message waits: the restart is the sweep's own, capped per stuck spell (task #404).
      // A background command or subagent may be what the turn waits on: never killed for this.
      if ((launch.backgroundTasks?.count ?? 0) > 0) return;
      const admission = this.#unattended.admit(agentId, launch, launch.progress?.lastCompletedAtMs);
      if (admission === "held") return;
      if (admission === "limit")
        return reportUnattendedLimit(this.#ports.publish, agentId, launch, restart);
      resumePrompt = unattendedResumePrompt(
        basis.silentForMs,
        this.#ports.lastBusy(agentId)?.activity.detail,
      );
    }
    await this.#endAndWake(
      agentId,
      launch,
      session,
      stalledRuntimePlan(restart, agentId, basis, resumePrompt),
    );
  }

  /** Restarts a live runtime so its next launch reads fresh launch config (a feature changed).
   * Whatever waits for the launch, the delivery that revealed the change included, is presented
   * by it. */
  canRestartForFreshConfig(agentId: string): boolean {
    return Boolean(
      this.#ports.launch(agentId) &&
      this.#ports.runtime(agentId)?.session &&
      this.#ports.restartConfig(agentId),
    );
  }

  async restartForFreshConfig(agentId: string): Promise<void> {
    const launch = this.#ports.launch(agentId);
    const session = this.#ports.runtime(agentId)?.session;
    const restart = this.#ports.restartConfig(agentId);
    if (!launch || !session || !restart) return;
    await this.#endAndWake(agentId, launch, session, freshConfigRuntimePlan(restart));
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

  /** Ends an idle runtime so its next launch reads a pushed configuration. The Agent is judged
   * again here by the cold idle sweep's guards; one that is no longer idle is left running.
   * A message that arrives meanwhile waits for the launch, as for a cold idle stop. */
  async stopForConfigApply(agentId: string): Promise<"stopped" | "busy" | "failed"> {
    const agent = this.coldIdleAgent(agentId);
    if (!agent || agent.busyReason !== undefined) return "busy";
    const launch = this.#ports.launch(agentId);
    const session = this.#ports.runtime(agentId)?.session;
    const restart = this.#ports.restartConfig(agentId);
    if (!launch || !session || !restart) return "busy";
    const ended = await this.#endAndWake(agentId, launch, session, configApplyRuntimePlan(restart));
    return ended ? "stopped" : "failed";
  }

  /** Ends the runtime, then wakes the Agent on its remembered restart config, resuming the
   * session it last reported. A relaunch that fails reports its own launch error; the waiting
   * messages stay queued, acknowledged, for the Agent's next launch. */
  async #endAndWake(
    agentId: string,
    launch: L,
    session: AgentSession,
    plan: RuntimeReleasePlan,
  ): Promise<boolean> {
    this.#recovering.add(agentId);
    try {
      if (!(await this.#end(agentId, launch, session, plan))) return false;
      // A Stop that arrived meanwhile wins, and its config, not the one read before, is current.
      const current = this.#ports.restartConfig(agentId);
      if (this.#ports.isStopping(agentId) || !current) return true;
      if (plan.wake.onlyIfParked && !this.#ports.hasParkedWork(agentId)) return true;
      const sessionId = this.#ports.sessionId(agentId) ?? current.sessionId;
      // From here a message joins the wake launch as any other does.
      this.#recovering.delete(agentId);
      const resumePrompt = plan.wake.resumePrompt;
      const next: WakeRestart = {
        ...current,
        sessionId,
        ...(resumePrompt ? { resumePrompt } : {}),
      };
      const woken = this.#ports.wake(agentId, next).catch((error: unknown) =>
        logger.error(plan.wake.failure.message, {
          event: plan.wake.failure.event,
          agent_id: agentId,
          error: thrownMessage(error),
        }),
      );
      if (plan.wake.awaited) await woken;
      return true;
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
    this.#ports.publish(agentId, launch, plan.announce.detailKind, "info", plan.announce.text);
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
        AGENT_ACTIVITY_DETAIL_KIND.RUNTIME_ERROR,
        "error",
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

/** Milliseconds since `atMs`, or undefined for a clock that never fired. */
function ageOf(atMs: number | undefined): number | undefined {
  return atMs === undefined ? undefined : Date.now() - atMs;
}
