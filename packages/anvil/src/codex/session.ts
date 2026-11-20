import type {
  AgentRuntimeEvent,
  AgentSession,
  AgentSessionExit,
  AgentSessionIdentity,
  AgentTurnProcessWindow,
} from "@coforge/agent";
import { AGENT_RUNTIME_EVENT_TYPE, asRecord, eventTime, nonEmptyString } from "@lrm/coforge-anvil";
import { codexContextUsage } from "./context-usage";
import { JsonlProcess } from "@lrm/coforge-anvil/execution";
import { CodexItemEvents } from "./item-events";
import { CodexSubagentThreads, codexMessageThreadId } from "./subagent-threads";
import { codexTurnOutcome } from "./turn-outcome";
import { CodexTurnSignals } from "./turn-signals";
import {
  AGENT_ACTIVITY_DETAIL_KIND,
  RUNTIME_PROVIDER,
  utf8Encoder,
  type AgentServiceTierObserved,
} from "@lrm/coforge-sdk/internal";
import { getLogger } from "@logtape/logtape";
import {
  acceptCodexCompactionRecord,
  acceptsCompactingTurnItem,
  runCodexCompactRequest,
} from "./compaction";
import { scrubError } from "./provider-support";
import { CodexTurnControl } from "./turn-control";

const logger = getLogger(["coforge", "daemon", "code-agent", RUNTIME_PROVIDER.CODEX]);

export class CodexAgentSession implements AgentSession {
  /** Busy input steers the live turn through `turn/steer`. */
  readonly steersBusyTurn = true;
  /** Delegated work runs on secondary threads the main turn never resumes on its own, so the
   * daemon writes the wake notice once the last subagent finishes. */
  readonly wakesAfterSubagents = true;
  readonly #process: JsonlProcess;
  readonly #threadId: string;
  readonly #agentId: string | undefined;
  readonly #runtimeId: string | undefined;
  readonly #listeners = new Set<(event: AgentRuntimeEvent) => void>();
  readonly #commandOutputBytes = new Map<string, number>();
  readonly #itemEvents = new CodexItemEvents();
  readonly #subagentThreads: CodexSubagentThreads;
  readonly #signals: CodexTurnSignals;
  readonly #turns: CodexTurnControl;
  #lastCompletedTurnId: string | undefined;
  #identity: AgentSessionIdentity;
  #replacementWarning: string | undefined;

  constructor(
    process: JsonlProcess,
    threadId: string,
    resumed: boolean,
    agentId?: string,
    runtimeId?: string,
    serviceTier?: AgentServiceTierObserved,
    replacementWarning?: string,
    model?: string,
    readonly readUsage?: AgentSession["readUsage"],
  ) {
    this.#process = process;
    this.#threadId = threadId;
    this.#subagentThreads = new CodexSubagentThreads(threadId);
    this.#agentId = agentId;
    this.#runtimeId = runtimeId;
    this.#signals = new CodexTurnSignals(threadId, agentId, runtimeId);
    this.#replacementWarning = replacementWarning;
    this.#identity = {
      sessionId: threadId,
      state: resumed ? "resumable" : "empty",
    };
    this.#turns = new CodexTurnControl({
      process,
      threadId,
      agentId,
      runtimeId,
      serviceTier,
      model,
      emit: (event) => this.#emit(event),
      setIdentity: (state) => this.#setIdentity(state),
    });
    process.onRecord((record) => this.#accept(record));
    process.onStderr((text) => {
      const match = /Reconnecting\.\.\.\s*(\d+)\s*\/\s*\d+/i.exec(text);
      if (!match) return;
      // Raw stderr line as the fact; the daemon core formats/redacts it into the
      // visible `runtime_reconnecting` Activity (agent-runtime/runtime-error-activity.ts).
      this.#emit({ type: "reconnecting", attempt: Number(match[1]), message: text });
    });
    // Whether an unexpected close reads as a crash is the daemon core's call, made
    // from this fact at the moment the process actually exits.
    process.onFailure((error) => this.#emit({ type: "error", message: error.message }));
  }

  async sendMessage(text: string): Promise<void> {
    return this.#turns.sendMessage(text);
  }

  get hasLiveTurn(): boolean {
    return this.#turns.hasLiveTurn;
  }

  get processId(): number | undefined {
    return this.#process.pid;
  }

  async notify(notice: string): Promise<void> {
    await this.#turns.acceptNotice(notice);
    logger.info("Codex accepted inbox wakeup", {
      event: "codex.wakeup.accepted",
      agent_id: this.#agentId,
      runtime_id: this.#runtimeId,
      notice_bytes: utf8Encoder.encode(notice).byteLength,
      outcome: "ok",
    });
  }

  subscribe(listener: (event: AgentRuntimeEvent) => void): () => void {
    this.#listeners.add(listener);
    if (this.#replacementWarning) {
      listener({
        type: "activity",
        activity: {
          detailKind: AGENT_ACTIVITY_DETAIL_KIND.SYSTEM_MESSAGE,
          level: "info",
          detail: "",
          observedAtMs: Date.now(),
          entries: [
            {
              kind: "system",
              title: "Codex resume recovery",
              text: this.#replacementWarning,
            },
          ],
        },
      });
      this.#replacementWarning = undefined;
    }
    return () => this.#listeners.delete(listener);
  }

  async readSessionIdentity(): Promise<AgentSessionIdentity> {
    return this.#identity;
  }

  async interrupt(): Promise<void> {
    return this.#turns.interrupt();
  }

  /** A subagent's own thread takes the same `turn/interrupt` the main thread does. */
  async interruptSubagent(taskId: string): Promise<"interrupted" | "not_running"> {
    const turn = this.#subagentThreads.runningSubagentTurn(taskId);
    if (!turn || this.#turns.isDisposed()) return "not_running";
    await this.#process.request({
      method: "turn/interrupt",
      params: { threadId: turn.threadId, turnId: turn.turnId },
    });
    return "interrupted";
  }

  async killTurnProcesses(window: AgentTurnProcessWindow): Promise<void> {
    await this.#process.killTurnProcesses(window);
  }

  async compact(): Promise<void> {
    if (this.#turns.state.type !== "idle") return;
    const compacting = runCodexCompactRequest({
      process: this.#process,
      threadId: this.#threadId,
      getState: () => this.#turns.state,
      setState: (next) => {
        this.#turns.state = next;
      },
      beginIdle: () => this.#turns.beginIdle(),
    });
    this.#turns.starting = compacting;
    try {
      await compacting;
    } finally {
      if (this.#turns.starting === compacting) this.#turns.starting = undefined;
    }
  }

  onExit(listener: (exit?: AgentSessionExit) => void): () => void {
    return this.#process.onClose(listener);
  }

  async dispose(options?: Readonly<{ cutoffAtMs?: number }>): Promise<void> {
    if (this.#turns.isDisposed()) return;
    if (this.#turns.state.type === "compacting") this.#turns.state.settle();
    this.#turns.state = { type: "disposed" };
    await this.#process.dispose(options);
  }

  #accept(record: Record<string, unknown>): void {
    const params = asRecord(record.params);
    // A subagent's own thread reports under its own id: its items and turn lifecycle are that
    // subagent's, never the main turn's — and they still arrive after the main turn has ended,
    // which is when the daemon counts them toward the quiet-turn wait.
    const messageThreadId = codexMessageThreadId(record);
    if (this.#subagentThreads.isSecondaryThreadId(messageThreadId)) {
      this.#emitAll(this.#subagentThreads.acceptSecondary(record, messageThreadId));
      return;
    }
    // Item notifications can arrive after turn/completed. They must not revive
    // Activity for an idle session, including completion before turn/start replies.
    if (
      typeof record.method === "string" &&
      (record.method.startsWith("item/") || record.method === "thread/tokenUsage/updated")
    ) {
      if (!this.#acceptsTurnItem(params)) return;
      if (record.method === "thread/tokenUsage/updated") {
        const usage = codexContextUsage(params);
        if (usage) this.#emitAll([{ type: AGENT_RUNTIME_EVENT_TYPE.CONTEXT_USAGE, ...usage }]);
        return;
      }
    }
    const signalEvents = this.#signals.notification(record, params);
    if (signalEvents) {
      this.#emitAll(signalEvents);
      return;
    }
    if (record.method === "error") {
      const error = asRecord(params?.error);
      if (
        params?.threadId !== this.#threadId ||
        typeof params.turnId !== "string" ||
        typeof params.willRetry !== "boolean" ||
        typeof error?.message !== "string"
      )
        return;
      if (params.willRetry) {
        logger.debug("Codex is retrying a provider request", {
          event: "codex.request.retrying",
          agent_id: this.#agentId,
          runtime_id: this.#runtimeId,
        });
        return;
      }
      this.#emit({ type: "error", message: error.message, occurredAt: eventTime(record) });
      return;
    }
    if (
      this.#turns.state.type === "compacting" &&
      acceptCodexCompactionRecord(this.#turns.state, record, params, {
        acceptsTurnItem: (itemParams) => this.#acceptsTurnItem(itemParams),
        lastCompletedTurnId: this.#lastCompletedTurnId,
        noteCompletedTurn: (turnId) => {
          this.#lastCompletedTurnId = turnId;
          this.#itemEvents.reset();
        },
        beginIdle: () => this.#turns.beginIdle(),
        consumePendingInterrupt: () => this.#turns.consumePendingInterrupt(),
        interrupt: () => void this.interrupt().catch(() => {}),
        emit: (event) => this.#emit(event),
        emitItemEvents: () => this.#emitAll(this.#itemEvents.accept(record, params)),
      })
    ) {
      return;
    }
    if (record.method === "turn/started") {
      const turn = asRecord(params?.turn);
      // Same fence as an item: only this thread's live turn opens a run.
      if (
        typeof turn?.id !== "string" ||
        !this.#acceptsTurnItem({ threadId: params?.threadId, turnId: turn.id })
      )
        return;
      this.#signals.reset();
      this.#emitAll(this.#itemEvents.accept(record, params));
      return;
    }
    const deltas = this.#itemEvents.delta(record, params);
    if (deltas) {
      this.#emitAll(deltas);
      return;
    }
    if (record.method === "item/started") {
      const item = asRecord(params?.item);
      if (item?.type === "commandExecution" && typeof item.id === "string")
        this.#commandOutputBytes.set(item.id, 0);
      this.#emitAll(this.#itemEvents.accept(record, params));
      return;
    }
    if (
      record.method === "item/commandExecution/outputDelta" &&
      typeof params?.itemId === "string" &&
      typeof params.delta === "string"
    ) {
      this.#commandOutputBytes.set(
        params.itemId,
        (this.#commandOutputBytes.get(params.itemId) ?? 0) +
          utf8Encoder.encode(params.delta).byteLength,
      );
      this.#emit({
        type: "tool-output",
        id: params.itemId,
        text: params.delta,
      });
      return;
    }
    if (record.method === "item/completed") {
      const item = asRecord(params?.item);
      if (item?.type === "commandExecution" && typeof item.id === "string") {
        logger.info("Codex command completed", {
          event: "codex.command.completed",
          agent_id: this.#agentId,
          runtime_id: this.#runtimeId,
          exit_code: typeof item.exitCode === "number" ? item.exitCode : undefined,
          output_bytes: this.#commandOutputBytes.get(item.id) ?? 0,
          outcome: item.exitCode === 0 ? "ok" : "failed",
        });
        this.#commandOutputBytes.delete(item.id);
      }
      this.#emitAll(this.#itemEvents.accept(record, params));
      // A completed collaboration call names the threads it spawned (or ended), after its own
      // tool-end, as the reference normalizer orders them.
      if (item && item.type === "collabAgentToolCall")
        this.#emitAll(
          this.#subagentThreads.noteCollabAgentStates(
            item,
            nonEmptyString(item.id),
            eventTime(record),
          ),
        );
      return;
    }
    if (record.method === "turn/completed") {
      const turn = asRecord(params?.turn);
      if (typeof turn?.id !== "string") return;
      if (turn.id === this.#lastCompletedTurnId) return;
      if (this.#turns.state.type === "starting") this.#turns.state.completedTurnIds.add(turn.id);
      else if (
        (this.#turns.state.type === "running" || this.#turns.state.type === "interrupting") &&
        this.#turns.state.turnId === turn.id
      ) {
        this.#turns.state = { type: "idle" };
      } else {
        return;
      }
      this.#commandOutputBytes.clear();
      this.#itemEvents.reset();
      this.#lastCompletedTurnId = turn.id;
      const { status, failure } = codexTurnOutcome(turn);
      if (failure) {
        // The raw message goes to the Activity (the daemon core redacts and truncates it); this
        // local scrub only bounds what reaches the daemon's own structured log line.
        logger.error("Codex turn failed", {
          event: "codex.turn.failed",
          agent_id: this.#agentId,
          runtime_id: this.#runtimeId,
          turn_status: turn.status,
          error_code: failure.code,
          error_message: scrubError(failure.message),
          outcome: "error",
        });
        this.#emit({
          type: "error",
          message: failure.message,
          occurredAt: eventTime(record),
          providerErrorClass: failure.code ?? "CodexTurnError",
          providerErrorReason: "turn_failed",
          ...(failure.sessionRecovery ? { sessionRecovery: failure.sessionRecovery } : {}),
        });
      }
      const signalErrors = this.#signals.finish(record, status);
      this.#emitAll(signalErrors);
      this.#emit({
        type: "completed",
        status: failure || signalErrors.length > 0 ? "failed" : status,
      });
    }
  }

  #emit(event: AgentRuntimeEvent): void {
    this.#signals.observe(event);
    for (const listener of this.#listeners) listener(event);
  }

  #emitAll(events: readonly AgentRuntimeEvent[]): void {
    for (const event of events) this.#emit(event);
  }

  #acceptsTurnItem(params: Record<string, unknown> | undefined): boolean {
    if (params?.threadId !== undefined && params.threadId !== this.#threadId) return false;
    const state = this.#turns.state;
    if (state.type === "idle" || state.type === "disposed") return false;
    if (typeof params?.turnId !== "string") return true;
    if (params.turnId === this.#lastCompletedTurnId) return false;
    if (state.type === "starting") return !state.completedTurnIds.has(params.turnId);
    if (state.type === "compacting") return acceptsCompactingTurnItem(state, params.turnId);
    return params.turnId === state.turnId;
  }

  #setIdentity(state: AgentSessionIdentity["state"]): void {
    if (this.#identity.state === state) return;
    this.#identity = { sessionId: this.#threadId, state };
    this.#emit({ type: "session", identity: this.#identity });
  }
}
