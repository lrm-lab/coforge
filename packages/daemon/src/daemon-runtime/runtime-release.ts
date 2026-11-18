import { getLogger } from "@logtape/logtape";
import {
  AGENT_ACTIVITY_DETAIL_KIND,
  thrownMessage,
  type AgentActivityRuntimeError,
} from "@lrm/coforge-sdk/internal";
import type { AgentSession } from "@lrm/coforge-anvil";
import type { AgentMessageDelivery } from "@lrm/coforge-sdk/internal";
import type { AgentRestartConfig, AgentRuntime } from "#src/agent-runtime/agent-process-manager";
import type { OutstandingBackgroundTasks } from "#src/agent-runtime/subagent-progress-activity";
import type { ToolCallLedger } from "#src/agent-runtime/tool-call-ledger";
import type { ColdIdleStop } from "#src/agent-runtime/wake-session-recycle";
import { StalledReplacements, reportStalledLimit } from "./stalled-recovery-unattended";
import { logStalledRecovery } from "./agent-failure-logs";
import { idleBlocker, type ColdIdleAgent } from "./cold-idle-sweep";
import type { DaemonIdleFacts } from "./agent-idle-facts";
import type { BusyActivity } from "./agent-activity-publisher";
import type { DeliveryHoldReason } from "./agent-delivery-gate";
import type { LaunchRequest } from "./runtime-launch-types";
import { stalledRuntime, type StalledRuntime } from "./runtime-release-stalled";
import {
  coldIdleRuntimePlan,
  configApplyRuntimePlan,
  freshConfigRuntimePlan,
  stalledRuntimePlan,
  type RuntimeEndPlan,
  type RuntimeReleasePlan,
} from "./runtime-release-plans";
import { runtimeDisplayName } from "./session-invalidate-activity";
import {
  STALLED_RECOVERY_EXIT_TIMEOUT_MS,
  stalledRecoveryDisplayText,
  unattendedResumePrompt,
  type ProviderProgress,
} from "./stalled-recovery";
export type { StalledRuntime } from "./runtime-release-stalled";
const logger = getLogger(["coforge", "daemon", "runtime"]);
export type ReleasableLaunch = {
  stopping: boolean;
  progress?: ProviderProgress;
  toolCalls?: ToolCallLedger;
  backgroundTasks?: OutstandingBackgroundTasks;
  lastContextTokens?: number;
};
export type WakeRestart = AgentRestartConfig &
  Readonly<{
    resumePrompt?: string;
  }>;
export function wakeRequest(restart: WakeRestart): LaunchRequest {
  return {
    sessionId: restart.sessionId,
    ...(restart.resumePrompt !== undefined ? { resumePrompt: restart.resumePrompt } : {}),
  };
}
export type RuntimeReleasePorts<L extends ReleasableLaunch> = Readonly<{
  launch(agentId: string): L | undefined;
  runtime(agentId: string): AgentRuntime | undefined;
  restartConfig(agentId: string): AgentRestartConfig | undefined;
  lastBusy(agentId: string): BusyActivity<L> | undefined;
  queuedForMs(agentId: string): number | undefined;
  explicitHold?(agentId: string): DeliveryHoldReason | undefined;
  credentialHeld?(agentId: string): boolean;
  noticeAcceptedAt?(agentId: string): number | undefined;
  noticeAcceptedForMs?(agentId: string): number | undefined;
  lastAgentActionForMs?(agentId: string): number | undefined;
  resumable(agentId: string): boolean;
  sessionId(agentId: string): string | undefined;
  isStopping(agentId: string): boolean;
  daemonIdleFacts(agentId: string): DaemonIdleFacts;
  hasParkedWork(agentId: string): boolean;
  flushParked(agentId: string): void;
  takeParked(agentId: string): readonly AgentMessageDelivery[];
  wake(agentId: string, restart: WakeRestart): Promise<unknown>;
  publish(
    agentId: string,
    launch: L,
    detailKind: string,
    level: "info" | "error",
    text: string,
    extra?: Readonly<{
      runtimeError?: AgentActivityRuntimeError;
    }>,
  ): void;
  carryMentions(agentId: string, freshSession: boolean): ReadonlyMap<string, number>;
  abortMentionCarry(agentId: string): void;
  release(agentId: string, timeoutMs: number): Promise<void>;
  reconcileIdleTurn?(agentId: string, launch: L): boolean;
}>;
export class RuntimeRelease<L extends ReleasableLaunch> {
  readonly #ports: RuntimeReleasePorts<L>;
  readonly #recovering = new Set<string>();
  readonly #probing = new Map<string, Promise<StalledRuntime<L> | undefined>>();
  readonly #replacements = new StalledReplacements();
  constructor(ports: RuntimeReleasePorts<L>) {
    this.#ports = ports;
  }
  isRecovering(agentId: string): boolean {
    return this.#recovering.has(agentId);
  }
  stalled(agentId: string): StalledRuntime<L> | undefined {
    return stalledRuntime(this.#ports, agentId);
  }
  needsStalledProbe(agentId: string): boolean {
    return this.#probing.has(agentId);
  }
  probeStalled(agentId: string): Promise<StalledRuntime<L> | undefined> {
    const existing = this.#probing.get(agentId);
    if (existing) return existing;
    const probe = (async () => {
      await this.reapBackgroundTasks(agentId);
      return stalledRuntime(this.#ports, agentId);
    })().finally(() => {
      if (this.#probing.get(agentId) === probe) this.#probing.delete(agentId);
    });
    this.#probing.set(agentId, probe);
    return probe;
  }
  async reapBackgroundTasks(agentId: string): Promise<void> {
    const launch = this.#ports.launch(agentId);
    if (!launch?.backgroundTasks) return;
    const reaped = await launch.backgroundTasks.reapZombies();
    if (reaped.length > 0 && launch.backgroundTasks.count === 0)
      this.#ports.reconcileIdleTurn?.(agentId, launch);
  }
  async recoverStalled(
    agentId: string,
    stalled: StalledRuntime<L>,
    options: Readonly<{
      unattended?: boolean;
    }> = {},
  ): Promise<void> {
    const { launch, session, restart, basis } = stalled;
    logStalledRecovery(agentId, basis);
    if (options.unattended && (launch.backgroundTasks?.count ?? 0) > 0) return;
    const admission = this.#replacements.admit(agentId, launch, launch.progress?.lastCompletedAtMs);
    if (admission === "held") return;
    if (admission === "limit")
      return reportStalledLimit(
        this.#ports.publish,
        agentId,
        launch,
        restart,
        options.unattended !== true,
      );
    let resumePrompt: string | undefined;
    if (options.unattended) {
      resumePrompt = unattendedResumePrompt(
        basis.silentForMs,
        this.#ports.lastBusy(agentId)?.activity.detail,
      );
    }
    this.#ports.publish(
      agentId,
      launch,
      AGENT_ACTIVITY_DETAIL_KIND.RUNTIME_STALLED,
      "error",
      stalledRecoveryDisplayText(runtimeDisplayName(restart.config.provider), basis),
    );
    await this.#endAndWake(
      agentId,
      launch,
      session,
      stalledRuntimePlan(restart, agentId, basis, resumePrompt),
    );
  }
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
  coldIdleAgent(agentId: string): ColdIdleAgent | undefined {
    const runtime = this.#ports.runtime(agentId);
    if (!runtime) return undefined;
    const launch = this.#ports.launch(agentId);
    const facts = this.#ports.daemonIdleFacts(agentId);
    const busyReason = idleBlocker({
      ...facts,
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
      ...(launch?.lastContextTokens !== undefined
        ? { lastContextTokens: launch.lastContextTokens }
        : {}),
    };
  }
  async stopColdIdle(stop: ColdIdleStop): Promise<void> {
    const { agentId } = stop;
    const launch = this.#ports.launch(agentId);
    const session = this.#ports.runtime(agentId)?.session;
    const restart = this.#ports.restartConfig(agentId);
    if (!launch || !session || !restart) return;
    await this.#endAndWake(agentId, launch, session, coldIdleRuntimePlan(restart, stop));
  }
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
  async #endAndWake(
    agentId: string,
    launch: L,
    session: AgentSession,
    plan: RuntimeReleasePlan,
  ): Promise<boolean> {
    return this.#endThen(agentId, launch, session, plan, false, async (current, join) => {
      const parked = !this.#ports.credentialHeld?.(agentId) && this.#ports.hasParkedWork(agentId);
      if (plan.wake.onlyIfParked && !parked) return;
      const sessionId = this.#ports.sessionId(agentId) ?? current.sessionId;
      join();
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
    });
  }
  async endAndReplace(
    agentId: string,
    plan: RuntimeEndPlan,
    replace: (
      parked: readonly AgentMessageDelivery[],
      carried: ReadonlyMap<string, number>,
    ) => void,
  ): Promise<boolean> {
    const launch = this.#ports.launch(agentId);
    const session = this.#ports.runtime(agentId)?.session;
    if (!launch || !session) return false;
    const facts = this.#ports.daemonIdleFacts(agentId);
    if (facts.runnerHold || facts.migrating || (launch.backgroundTasks?.count ?? 0) > 0)
      return false;
    let replaced = false;
    await this.#endThen(agentId, launch, session, plan, true, (_, join, carried) => {
      if (this.#ports.launch(agentId) !== launch) return;
      join();
      replace(this.#ports.takeParked(agentId), carried);
      replaced = true;
    });
    return replaced;
  }
  async #endThen(
    agentId: string,
    launch: L,
    session: AgentSession,
    plan: RuntimeEndPlan,
    freshSession: boolean,
    proceed: (
      current: AgentRestartConfig,
      join: () => void,
      carried: ReadonlyMap<string, number>,
    ) => void | Promise<void>,
  ): Promise<boolean> {
    this.#recovering.add(agentId);
    try {
      const carried = await this.#end(agentId, launch, session, plan, freshSession);
      if (!carried) return false;
      const current = this.#ports.restartConfig(agentId);
      if (this.#ports.isStopping(agentId) || !current) return true;
      await proceed(current, () => this.#recovering.delete(agentId), carried);
      return true;
    } finally {
      this.#recovering.delete(agentId);
    }
  }
  async #end(
    agentId: string,
    launch: L,
    session: AgentSession,
    plan: RuntimeEndPlan,
    freshSession: boolean,
  ): Promise<ReadonlyMap<string, number> | undefined> {
    if (plan.announce)
      this.#ports.publish(agentId, launch, plan.announce.detailKind, "info", plan.announce.text);
    plan.log?.();
    launch.stopping = true;
    try {
      await this.#ports.release(agentId, STALLED_RECOVERY_EXIT_TIMEOUT_MS);
      return this.#ports.carryMentions(agentId, freshSession);
    } catch (error) {
      this.#ports.abortMentionCarry(agentId);
      if (!plan.keepProgress) launch.progress = undefined;
      const stillRunning = this.#ports.runtime(agentId)?.session === session;
      if (stillRunning) {
        launch.stopping = false;
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
      return undefined;
    }
  }
}
