import type { AgentRuntimeEvent } from "@coforge/agent";
import { asRecord, eventTime } from "@lrm/coforge-anvil";
import type { JsonlProcess } from "@lrm/coforge-anvil/execution";
import { codexTurnOutcome } from "./turn-outcome";
import type { CodexSessionState } from "./provider-support";

export type CodexCompactingState = {
  type: "compacting";
  turnId?: string;
  completedTurnIds: Set<string>;
  sawCompactionStarted: boolean;
  sawCompactionFinished: boolean;
  rpcReplied: boolean;
  noteStarted: () => void;
  settle: () => void;
  fail: (error: Error) => void;
};

const COMPACT_START_GRACE_MS = 5_000;

export function acceptsCompactingTurnItem(state: CodexCompactingState, turnId: string): boolean {
  return state.turnId !== undefined ? turnId === state.turnId : !state.completedTurnIds.has(turnId);
}

export async function runCodexCompactRequest(options: {
  process: JsonlProcess;
  threadId: string;
  getState: () => CodexSessionState;
  setState: (next: CodexCompactingState) => void;
  beginIdle: () => void;
  startGraceMs?: number;
}): Promise<void> {
  const settled = Promise.withResolvers<void>();
  let startGraceTimer: ReturnType<typeof setTimeout> | undefined;
  const clearGrace = () => {
    if (startGraceTimer === undefined) return;
    clearTimeout(startGraceTimer);
    startGraceTimer = undefined;
  };
  const state: CodexCompactingState = {
    type: "compacting",
    completedTurnIds: new Set(),
    sawCompactionStarted: false,
    sawCompactionFinished: false,
    rpcReplied: false,
    noteStarted: clearGrace,
    settle: () => {
      clearGrace();
      settled.resolve();
    },
    fail: (error) => {
      clearGrace();
      settled.reject(error);
    },
  };
  options.setState(state);
  let response: Readonly<Record<string, unknown>>;
  try {
    response = await options.process.request({
      method: "thread/compact/start",
      params: { threadId: options.threadId },
    });
  } catch (error) {
    if (options.getState() === state) {
      options.beginIdle();
      state.settle();
    }
    throw error;
  }
  if (options.getState() !== state) return;
  const turnId = asRecord(asRecord(response.result)?.turn)?.id;
  if (typeof turnId === "string") state.turnId = turnId;
  state.rpcReplied = true;
  if (
    (state.turnId !== undefined && state.completedTurnIds.has(state.turnId)) ||
    (state.turnId === undefined && (state.completedTurnIds.size > 0 || state.sawCompactionFinished))
  ) {
    options.beginIdle();
    state.settle();
    return;
  }
  if (state.turnId === undefined && !state.sawCompactionStarted) {
    startGraceTimer = setTimeout(() => {
      startGraceTimer = undefined;
      if (
        options.getState() === state &&
        state.turnId === undefined &&
        !state.sawCompactionStarted
      ) {
        options.beginIdle();
        state.settle();
      }
    }, options.startGraceMs ?? COMPACT_START_GRACE_MS);
    startGraceTimer.unref?.();
  }
  await settled.promise;
}

export function acceptCodexCompactionRecord(
  state: CodexCompactingState,
  record: Record<string, unknown>,
  params: Record<string, unknown> | undefined,
  hooks: {
    acceptsTurnItem: (params: Record<string, unknown> | undefined) => boolean;
    lastCompletedTurnId: string | undefined;
    noteCompletedTurn: (turnId: string) => void;
    beginIdle: () => void;
    consumePendingInterrupt: () => boolean;
    interrupt: () => void;
    emit: (event: AgentRuntimeEvent) => void;
    emitItemEvents: () => void;
  },
): boolean {
  if (record.method === "turn/started") {
    const turn = asRecord(params?.turn);
    if (
      typeof turn?.id !== "string" ||
      !hooks.acceptsTurnItem({ threadId: params?.threadId, turnId: turn.id })
    ) {
      return true;
    }
    state.turnId = turn.id;
    state.noteStarted();
    if (hooks.consumePendingInterrupt()) hooks.interrupt();
    return true;
  }
  if (record.method === "item/started") {
    const item = asRecord(params?.item);
    if (item?.type === "contextCompaction") {
      state.sawCompactionStarted = true;
      state.noteStarted();
    }
    hooks.emitItemEvents();
    return true;
  }
  if (record.method === "item/completed") {
    const item = asRecord(params?.item);
    hooks.emitItemEvents();
    if (item?.type === "contextCompaction") {
      state.sawCompactionFinished = true;
      if (state.rpcReplied && state.turnId === undefined) {
        hooks.beginIdle();
        state.settle();
      }
    }
    return true;
  }
  if (record.method === "turn/completed") {
    const turn = asRecord(params?.turn);
    if (typeof turn?.id !== "string" || turn.id === hooks.lastCompletedTurnId) return true;
    if (state.turnId !== undefined && state.turnId !== turn.id) return false;
    state.completedTurnIds.add(turn.id);
    hooks.noteCompletedTurn(turn.id);
    const { failure } = codexTurnOutcome(turn);
    const { sawCompactionStarted, sawCompactionFinished, settle, fail } = state;
    hooks.beginIdle();
    if (failure) {
      if (sawCompactionStarted && !sawCompactionFinished) {
        hooks.emit({
          type: "compaction-interrupted",
          reason: failure.message,
          occurredAt: eventTime(record),
        });
      }
      fail(new Error(failure.message));
      return true;
    }
    settle();
    return true;
  }
  return false;
}
