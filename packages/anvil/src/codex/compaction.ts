import type { AgentRuntimeEvent } from "@coforge/agent";
import { asRecord, eventTime } from "@lrm/coforge-anvil";
import type { JsonlProcess } from "@lrm/coforge-anvil/execution";
import { getLogger } from "@logtape/logtape";
import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import { codexTurnOutcome } from "./turn-outcome";
import type { CodexSessionState } from "./provider-support";

const logger = getLogger(["coforge", "daemon", "code-agent", RUNTIME_PROVIDER.CODEX]);

export const TURN_END_COMPACTION_WAIT_MS = 10 * 60_000;
export const TURN_END_COMPACTION_PROGRESS_MS = 5 * 60_000;

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
  waitMs?: number;
  progressNoticeMs?: number;
  onProgress?: () => void;
  onUnconfirmed?: () => void;
}): Promise<void> {
  const settled = Promise.withResolvers<void>();
  let startGraceTimer: ReturnType<typeof setTimeout> | undefined;
  let progressTimer: ReturnType<typeof setTimeout> | undefined;
  let waitTimer: ReturnType<typeof setTimeout> | undefined;
  const clearGrace = () => {
    if (startGraceTimer === undefined) return;
    clearTimeout(startGraceTimer);
    startGraceTimer = undefined;
  };
  const clearWaitTimers = () => {
    if (progressTimer !== undefined) {
      clearTimeout(progressTimer);
      progressTimer = undefined;
    }
    if (waitTimer !== undefined) {
      clearTimeout(waitTimer);
      waitTimer = undefined;
    }
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
      clearWaitTimers();
      settled.resolve();
    },
    fail: (error) => {
      clearGrace();
      clearWaitTimers();
      settled.reject(error);
    },
  };
  options.setState(state);
  const progressMs = options.progressNoticeMs ?? TURN_END_COMPACTION_PROGRESS_MS;
  const waitMs = options.waitMs ?? TURN_END_COMPACTION_WAIT_MS;
  if (progressMs > 0 && progressMs < waitMs) {
    progressTimer = setTimeout(() => {
      progressTimer = undefined;
      if (options.getState() !== state) return;
      logger.info("Codex compaction still in progress", {
        event: "codex.compaction.in_progress",
        thread_id: options.threadId,
        elapsed_ms: progressMs,
      });
      options.onProgress?.();
    }, progressMs);
    progressTimer.unref?.();
  }
  waitTimer = setTimeout(() => {
    waitTimer = undefined;
    if (options.getState() !== state) return;
    logger.warn("Codex compaction wait timed out; marking unconfirmed without canceling", {
      event: "codex.compaction.unconfirmed",
      thread_id: options.threadId,
      wait_ms: waitMs,
    });
    options.onUnconfirmed?.();
    options.beginIdle();
    state.settle();
  }, waitMs);
  waitTimer.unref?.();
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
    redact?: (line: string) => string;
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
    const { failure } = codexTurnOutcome(turn, Boolean(hooks.redact));
    const { sawCompactionStarted, sawCompactionFinished, settle, fail } = state;
    hooks.beginIdle();
    if (failure) {
      const message = hooks.redact?.(failure.message) ?? failure.message;
      if (sawCompactionStarted && !sawCompactionFinished) {
        hooks.emit({
          type: "compaction-interrupted",
          reason: message,
          occurredAt: eventTime(record),
        });
      }
      fail(new Error(message));
      return true;
    }
    settle();
    return true;
  }
  return false;
}
