import { startupDeadlineMs } from "@lrm/coforge-sdk/internal";
import type { AgentControlEvents } from "./agent-control-events.server";
import type { AgentStopReasonRecorder } from "./agent-control-receiver.server";
import type { AgentRuntimeLock } from "./agent-runtime-lock.server";
import type { AgentControlSignal } from "./agent-control-signal.server";
import {
  current,
  nextControlEpoch,
  startupWindow,
  TRANSIENT_FAILURE_MAX_WINDOW_MS,
  type AgentControlAgent,
  type AgentControlState,
  type AgentControlStore,
} from "./agent-control-types.server";

export const STARTUP_DEADLINE_ERROR_CODE = "startup_deadline_exceeded";
export const STARTUP_STOP_CONFIRM_MS = 60_000;

export type StartupStopOutcome = "confirmed" | "unconfirmed" | "offline";
export type StartupSettleOutcome =
  | "skipped"
  | "armed"
  | "stop_sent"
  | "waiting"
  | "failed"
  | "lost";

type Settlement = {
  store: AgentControlStore;
  signal: Pick<AgentControlSignal, "notify">;
  events?: Pick<AgentControlEvents, "publish">;
  stopReasons?: AgentStopReasonRecorder;
};

export async function settleStartupTimeout(
  deps: Settlement,
  agent: AgentControlAgent & { state: AgentControlState },
  input: { outcome: StartupStopOutcome; now: number; controlSequence?: number },
): Promise<boolean> {
  const state = agent.state;
  const {
    stopSentAtMs: _stopSentAtMs,
    errorCode: _errorCode,
    deadlineExtendedOfflineAtMs: _extendedOfflineAtMs,
    failedStreak,
    ...fields
  } = state;
  const next: AgentControlState = {
    ...fields,
    phase: "failed",
    controlSequence: input.controlSequence ?? state.controlSequence,
    errorCode: STARTUP_DEADLINE_ERROR_CODE,
    failedAtMs: input.now,
    failedStreak: (failedStreak ?? 0) + 1,
  };
  if (!(await deps.store.replace(agent, next))) return false;
  console.warn(
    JSON.stringify({
      event: "agent_control:startup_timeout",
      agent_id: agent.id,
      workspace_id: state.workspaceId,
      computer_id: state.computerId,
      request_id: state.requestId,
      epoch: state.epoch,
      provider: state.provider,
      elapsed_ms: input.now - (state.startedAtMs ?? input.now),
      stop_outcome: input.outcome,
    }),
  );
  void deps.stopReasons?.(agent, STARTUP_DEADLINE_ERROR_CODE).catch(() => {});
  deps.events?.publish(agent, {
    agentId: agent.id,
    requestId: state.requestId,
    action: state.action,
    phase: "failed",
    errorCode: STARTUP_DEADLINE_ERROR_CODE,
  });
  await deps.signal.notify(agent.id).catch(() => {});
  return true;
}

export class AgentControlStartupTimeout {
  constructor(
    private readonly deps: Settlement & {
      runtimeLock: AgentRuntimeLock;
      sendStop(state: AgentControlState): Promise<void>;
      computerOnline(scope: { workspaceId: string; computerId: string }): Promise<boolean>;
      clock(): number;
    },
  ) {}

  settle(agentId: string): Promise<StartupSettleOutcome> {
    return this.deps.runtimeLock.run(agentId, () => this.#settle(agentId));
  }

  async #settle(agentId: string): Promise<StartupSettleOutcome> {
    const { store, clock } = this.deps;
    const agent = await store.get(agentId);
    const state = agent?.state;
    if (!agent || !state || state.phase !== "starting" || !current(agent, state)) return "skipped";
    const settling = { ...agent, state };
    const now = clock();
    if (state.deadlineAtMs === undefined) {
      const armed = { ...state, ...startupWindow(state.provider, now) };
      return (await store.replace(agent, armed)) ? "armed" : "lost";
    }
    if (now < state.deadlineAtMs) return "skipped";
    if (state.stopSentAtMs !== undefined) {
      if (now < state.stopSentAtMs + STARTUP_STOP_CONFIRM_MS) return "waiting";
      return this.#fail(settling, "unconfirmed", now);
    }
    const online = await this.deps.computerOnline({
      workspaceId: state.workspaceId,
      computerId: state.computerId,
    });
    if (!online) {
      const startedAtMs = state.startedAtMs ?? now;
      if (now - startedAtMs > TRANSIENT_FAILURE_MAX_WINDOW_MS)
        return this.#fail(settling, "offline", now);
      const extended = {
        ...state,
        deadlineAtMs: now + startupDeadlineMs(state.provider),
        deadlineExtendedOfflineAtMs: now,
      };
      return (await store.replace(agent, extended)) ? "waiting" : "lost";
    }
    if (state.deadlineExtendedOfflineAtMs !== undefined) {
      const { deadlineExtendedOfflineAtMs: _extended, ...rest } = state;
      const rearmed = { ...rest, deadlineAtMs: now + startupDeadlineMs(state.provider) };
      return (await store.replace(agent, rearmed)) ? "waiting" : "lost";
    }
    const fenced = {
      ...state,
      epoch: nextControlEpoch(state),
      controlSequence: 0,
      stopSentAtMs: now,
    };
    if (!(await store.replace(agent, fenced))) return "lost";
    await this.deps.sendStop(fenced).catch((error: unknown) =>
      console.warn(
        JSON.stringify({
          event: "agent_control:startup_stop_publish_failed",
          agent_id: agent.id,
          request_id: state.requestId,
          error_type: error instanceof Error ? error.name : typeof error,
        }),
      ),
    );
    return "stop_sent";
  }

  async #fail(
    agent: AgentControlAgent & { state: AgentControlState },
    outcome: StartupStopOutcome,
    now: number,
  ): Promise<StartupSettleOutcome> {
    return (await settleStartupTimeout(this.deps, agent, { outcome, now })) ? "failed" : "lost";
  }
}
