import { getLogger } from "@logtape/logtape";
import { thrownMessage, type RuntimeProvider } from "@lrm/coforge-sdk/internal";
import type { CodeAgentProvider, SessionResumeFacts } from "@lrm/coforge-anvil";
import {
  resolveWakeRecycleConfig,
  resolveWakeRecycleSweepMs,
  resolveWarmRecycleConfig,
  selectColdIdleStops,
  type ColdIdleStop,
  type ColdIdleSweepView,
} from "#src/agent-runtime/wake-session-recycle";
import { scheduleUnrefTimer } from "./unref-timer";
const logger = getLogger(["coforge", "daemon", "runtime"]);
export type AgentIdleFacts = Readonly<{
  launched: boolean;
  hasLiveTurn: boolean | undefined;
  working: boolean;
  deliveriesQueued: boolean;
  deliveryInFlight: boolean;
  inputsQueued: boolean;
  trackedMentionOpen: boolean;
  openToolCall: boolean;
  backgroundTasks: number;
  launching: boolean;
  stopping: boolean;
  recoveringStalledRuntime: boolean;
  runnerHold: boolean;
  migrating: boolean;
}>;
export type IdleBlocker =
  | "not_launched"
  | "launching"
  | "stopping"
  | "stalled_recovery"
  | "runner_hold"
  | "migrating"
  | "live_turn"
  | "live_turn_unknown"
  | "working"
  | "delivery_in_flight"
  | "queued_delivery"
  | "queued_input"
  | "tracked_mention"
  | "open_tool_call"
  | "background_tasks";
export function idleBlocker(facts: AgentIdleFacts): IdleBlocker | undefined {
  if (!facts.launched) return "not_launched";
  if (facts.launching) return "launching";
  if (facts.stopping) return "stopping";
  if (facts.recoveringStalledRuntime) return "stalled_recovery";
  if (facts.runnerHold) return "runner_hold";
  if (facts.migrating) return "migrating";
  if (facts.hasLiveTurn === undefined) return "live_turn_unknown";
  if (facts.hasLiveTurn) return "live_turn";
  if (facts.working) return "working";
  if (facts.deliveryInFlight) return "delivery_in_flight";
  if (facts.deliveriesQueued) return "queued_delivery";
  if (facts.inputsQueued) return "queued_input";
  if (facts.trackedMentionOpen) return "tracked_mention";
  if (facts.openToolCall) return "open_tool_call";
  if (facts.backgroundTasks > 0) return "background_tasks";
  return undefined;
}
export type ColdIdleAgent = Omit<ColdIdleSweepView, "supported">;
export type ColdIdleSweepPorts = Readonly<{
  agentIds(): string[];
  agent(agentId: string): ColdIdleAgent | undefined;
  provider(provider: RuntimeProvider): CodeAgentProvider;
  stop(stop: ColdIdleStop): Promise<void>;
  now?(): number;
}>;
export function supportsSessionResume(provider: CodeAgentProvider): boolean {
  return provider.readSessionResumeFacts !== undefined;
}
export class ColdIdleSweep {
  readonly #ports: ColdIdleSweepPorts;
  readonly #warmTimers = new Map<string, () => void>();
  #timer: ReturnType<typeof setInterval> | undefined;
  #running: Promise<void> | undefined;
  constructor(ports: ColdIdleSweepPorts) {
    this.#ports = ports;
  }
  start(): void {
    if (this.#timer) return;
    const explicitSweep = Bun.env.COFORGE_WAKE_RECYCLE_SWEEP_MS?.trim();
    const periodMs = explicitSweep
      ? resolveWakeRecycleSweepMs()
      : Math.min(resolveWakeRecycleSweepMs(), resolveWarmRecycleConfig().warmQuietMs);
    this.#timer = setInterval(() => void this.sweep(), periodMs);
    this.#timer.unref();
  }
  stop(): void {
    clearInterval(this.#timer);
    this.#timer = undefined;
    for (const cancel of this.#warmTimers.values()) cancel();
    this.#warmTimers.clear();
  }
  cancelWarmCheck(agentId: string): void {
    this.#warmTimers.get(agentId)?.();
    this.#warmTimers.delete(agentId);
  }
  notifyIdle(
    agentId: string,
    options?: Readonly<{ immediateOnly?: boolean; recheck?: boolean }>,
  ): boolean {
    const agent = this.#ports.agent(agentId);
    if (!agent || !agent.sessionId || agent.lastContextTokens === undefined) return false;
    const provider = this.#ports.provider(agent.provider);
    if (!supportsSessionResume(provider)) return false;
    const config = resolveWakeRecycleConfig(
      agent.envVars,
      Bun.env,
      provider.idleRecycleMinColdGapMs,
    );
    if (!config.enabled) return false;
    const warm = resolveWarmRecycleConfig(agent.envVars, Bun.env);
    if (agent.busyReason !== undefined) {
      if (
        !options?.recheck &&
        (agent.busyReason === "queued_input" || agent.busyReason === "launching") &&
        agent.lastContextTokens > warm.warmMinContextTokens
      ) {
        this.cancelWarmCheck(agentId);
        this.#warmTimers.set(
          agentId,
          scheduleUnrefTimer(async () => {
            this.#warmTimers.delete(agentId);
            this.notifyIdle(agentId, { recheck: true });
          }, 10),
        );
        return agent.lastContextTokens > warm.immediateContextTokens;
      }
      return false;
    }
    const now = this.#now();
    const idleMs = Math.max(0, now - (agent.lastEventAtMs ?? now));
    if (agent.lastContextTokens > warm.immediateContextTokens) {
      this.cancelWarmCheck(agentId);
      void this.sweep();
      return true;
    }
    if (options?.immediateOnly || agent.lastContextTokens <= warm.warmMinContextTokens) {
      return false;
    }
    if (idleMs > warm.warmQuietMs) {
      this.cancelWarmCheck(agentId);
      void this.sweep();
      return true;
    }
    this.cancelWarmCheck(agentId);
    const delayMs = Math.max(10, warm.warmQuietMs - idleMs + 25);
    this.#warmTimers.set(
      agentId,
      scheduleUnrefTimer(async () => {
        this.#warmTimers.delete(agentId);
        void this.sweep();
      }, delayMs),
    );
    return false;
  }
  sweep(): Promise<void> {
    this.#running ??= this.#sweep()
      .catch((error: unknown) =>
        logger.warn("Agent cold idle sweep failed", {
          event: "agent.runtime.cold_idle_sweep_failed",
          error: thrownMessage(error),
        }),
      )
      .finally(() => {
        this.#running = undefined;
      });
    return this.#running;
  }
  async #sweep(): Promise<void> {
    const views = this.#views();
    const skipped: Record<string, number> = {};
    const stops = await selectColdIdleStops(views, {
      nowMs: this.#now(),
      readFacts: (view, sessionId) => this.#readFacts(view, sessionId),
      onSkip: (_agentId, reason) => {
        skipped[reason] = (skipped[reason] ?? 0) + 1;
      },
    });
    const judgedEventAtMs = new Map(views.map((view) => [view.agentId, view.lastEventAtMs]));
    let stopped = 0;
    for (const stop of stops) {
      const now = this.#ports.agent(stop.agentId);
      if (
        now?.busyReason !== undefined ||
        now?.sessionId !== stop.sessionId ||
        now.lastEventAtMs !== judgedEventAtMs.get(stop.agentId)
      ) {
        skipped.became_busy = (skipped.became_busy ?? 0) + 1;
        continue;
      }
      stopped++;
      await this.#ports.stop(stop).catch((error: unknown) =>
        logger.warn("Agent cold idle stop failed", {
          event: "agent.runtime.cold_idle_stop_failed",
          agent_id: stop.agentId,
          error: thrownMessage(error),
        }),
      );
    }
    if (views.length > 0)
      logger.info("Agent cold idle sweep", {
        event: "agent.runtime.cold_idle_sweep",
        agents: views.length,
        stops: stopped,
        ...Object.fromEntries(
          Object.entries(skipped).map(([reason, count]) => [`skipped_${reason}`, count]),
        ),
      });
  }
  #views(): ColdIdleSweepView[] {
    return this.#ports.agentIds().flatMap((agentId) => {
      const agent = this.#ports.agent(agentId);
      if (!agent) return [];
      const provider = this.#ports.provider(agent.provider);
      return [
        {
          ...agent,
          supported: supportsSessionResume(provider),
          ...(provider.idleRecycleMinColdGapMs !== undefined
            ? { providerMinColdGapMs: provider.idleRecycleMinColdGapMs }
            : {}),
        },
      ];
    });
  }
  async #readFacts(
    view: ColdIdleSweepView,
    sessionId: string,
  ): Promise<SessionResumeFacts | undefined> {
    return this.#ports
      .provider(view.provider)
      .readSessionResumeFacts?.({ sessionId, ...(view.envVars ? { envVars: view.envVars } : {}) });
  }
  #now(): number {
    return this.#ports.now?.() ?? Date.now();
  }
}
