import { prepareAgentNotice } from "@coforge/agent";
import type { ClaudeTurnHost } from "./host";
import type {
  AgentNoticeOptions,
  AgentSession,
  AgentSessionExit,
  AgentSessionIdentity,
  AgentSessionOptions,
  AgentTurnProcessWindow,
  AgentRuntimeEvent,
} from "@coforge/agent";
import { AGENT_RUNTIME_EVENT_TYPE } from "#src/contract";
import { InterruptTracker } from "#src/interrupt-tracker";
import { eventTime } from "#src/json-record";
import type { JsonlProcess } from "#src/jsonl-process";
import { ClaudeNoticeQueue, type SessionState, type SessionInitialization } from "./session-state";
import { initializeClaudeSession } from "./initialize";
import { compactBoundaryTokens } from "./compact-boundary";
import {
  claudeCompactionFailure,
  isClaudeCompactionOverflow,
  type ClaudeFailureEvent,
} from "./compaction-error";
import { ClaudeStreamEvents } from "./stream-events";
import {
  claudeAssistantEvents,
  claudeRefusalEvent,
  claudeToolResults,
  hasClaudeSessionProgress,
  isClaudeNativeTurnStart,
  readClaudeInitSessionId,
  isClaudeMainSessionRecord,
} from "./message-events";
import { ClaudeSubagentLineage } from "./subagent-lineage";
import { claudeModelWindowAvailable, ClaudeRateLimitState } from "./rate-limit";
import { ClaudeSessionObservations } from "./observations";
import { CLAUDE_PROCESS_EXITED, observeClaudeProcess } from "./process-observation";
import { relayTaskLifecycle, taskProgressEvent, type TrackedTask } from "./task-lifecycle";
import { SessionExit } from "#src/session-exit";

export class ClaudeCodeAgentSession implements AgentSession {
  readonly steersBusyTurn = true;
  #process: JsonlProcess;
  readonly #exit = new SessionExit();
  #closed = false;
  #firstInput: string | undefined;
  #progressObserved = false;
  #replacedSessionId: string | undefined;
  readonly #removePrompt: () => Promise<void>;
  readonly #listeners = new Set<(event: AgentRuntimeEvent) => void>();
  #state: SessionState = "idle";
  #nativeTurnQueued = false;
  #turnRefused = false;
  #turnErrorReported = false;
  /** Whether a top-level `result` has been seen. Set once and never reset: the fresh relau
   * (`#startFresh`) runs only before any progress, and a result is progress. */
  #resultObserved = false;
  #initialized = false;
  #nativeIdentityObserved = false;
  #initialization: SessionInitialization | undefined;
  #sessionId: string | undefined;
  #sessionReports = Promise.resolve();
  #identity: AgentSessionIdentity | undefined;
  // A fresh Claude session becomes ready at its first result.
  #sessionReadyForNotices = false;
  #compacting = false;
  #deferredCompactionError: ClaudeFailureEvent | undefined;
  /** Live non-ambient tasks by id: tool call and lifecycle kind; types in `#subagentLineage`. */
  readonly #tasks = new Map<string, TrackedTask>();
  readonly #subagentLineage = new ClaudeSubagentLineage();
  #nextSubagentStop = 0;
  readonly #streamEvents: ClaudeStreamEvents;
  #recoveryFailed = false;
  readonly #outstandingTools = new Set<string>();
  readonly #notices = new ClaudeNoticeQueue();
  readonly #rateLimits = new ClaudeRateLimitState();
  readonly #observations: ClaudeSessionObservations;
  #interrupt = new InterruptTracker();

  constructor(
    turnHost: ClaudeTurnHost,
    process: JsonlProcess,
    removePrompt: () => Promise<void>,
    private readonly reportSessionId?: AgentSessionOptions["onSessionId"],
    private expectedSessionId?: string,
    private readonly spawnFresh?: () => { process: JsonlProcess; sessionId: string },
    initialFreshSessionId?: string,
    configuredModel?: string,
    autoCompactWindow?: number,
  ) {
    this.#streamEvents = new ClaudeStreamEvents(turnHost);
    this.#process = process;
    this.#removePrompt = removePrompt;
    this.#observations = new ClaudeSessionObservations(configuredModel, autoCompactWindow);
    if (expectedSessionId) {
      this.#sessionId = expectedSessionId;
      this.#identity = { sessionId: expectedSessionId, state: "unknown" };
    } else if (initialFreshSessionId) {
      this.#sessionId = initialFreshSessionId;
      this.#identity = { sessionId: initialFreshSessionId, state: "empty" };
    }
    this.#bindProcess(process);
  }

  #bindProcess(process: JsonlProcess): void {
    observeClaudeProcess(process, this.expectedSessionId, {
      isCurrent: () => this.#process === process,
      beforeProgress: () => !this.#progressObserved && !this.#recoveryFailed,
      accept: (record) => this.#accept(record),
      onFailure: (error) => {
        this.#interrupt.fail(error);
        this.#notices.reject(error);
        this.#emit({ type: "error", message: error.message });
      },
      recoverMissingSession: () => this.#recoverMissingSession(),
      onClose: (exit, failure) => this.#handleProcessClose(exit, failure),
    });
  }

  #recoverMissingSession(): boolean {
    if (
      !this.expectedSessionId ||
      this.#replacedSessionId ||
      this.#progressObserved ||
      this.#recoveryFailed ||
      this.#state === "disposed" ||
      !this.spawnFresh
    )
      return false;
    this.#replacedSessionId = this.expectedSessionId;
    this.expectedSessionId = undefined;
    this.#initialized = false;
    this.#nativeIdentityObserved = false;
    void this.#startFresh().catch((error: unknown) => {
      this.#notices.reject(error instanceof Error ? error : new Error(String(error)));
      this.#emit({ type: "error", message: "Claude fresh session launch failed" });
      void this.dispose().catch(() => undefined);
    });
    return true;
  }

  #handleProcessClose(exit: AgentSessionExit | undefined, failure: Error | undefined): void {
    if (failure && this.#state !== "disposed")
      this.#emit(
        this.#state === "running" && failure.message === CLAUDE_PROCESS_EXITED
          ? (this.#deferredCompactionError ?? { type: "error", message: failure.message })
          : { type: "error", message: failure.message },
      );
    this.#deferredCompactionError = undefined;
    this.#interrupt.fail(failure ?? new Error("code agent process closed during interrupt"));
    this.#notices.reject(new Error("code agent process closed before writing input"));
    void this.#removePrompt().catch(() => {});
    this.#finishClose(exit);
  }

  async #startFresh(): Promise<void> {
    const firstInput = this.#firstInput;
    const fresh = this.spawnFresh!();
    this.#process = fresh.process;
    this.#sessionId = fresh.sessionId;
    // The old process's tasks never report again: end each one, so the daemon stops counting it.
    for (const [taskId, tracked] of this.#tasks)
      this.#emit(
        taskProgressEvent({
          phase: "notification",
          taskId,
          toolUseId: tracked.toolUseId,
          subagentType: this.#subagentLineage.typeOf(tracked.toolUseId),
          taskKind: tracked.taskKind,
          taskStatus: "stopped",
        }),
      );
    this.#tasks.clear();
    this.#subagentLineage.clear();
    this.#identity = { sessionId: fresh.sessionId, state: "empty" };
    this.#bindProcess(this.#process);
    await this.ready();
    if (this.#isDisposed()) return;
    if (firstInput !== undefined) await this.#sendInput(firstInput);
  }

  async ready(): Promise<void> {
    if (this.#initialized) return;
    const process = this.#process;
    if (this.#initialization?.process === process) return this.#initialization.promise;
    const promise = this.#initialize(process);
    this.#initialization = { process, promise };
    return promise;
  }

  #initialize(process: JsonlProcess): Promise<void> {
    return initializeClaudeSession(process, {
      initialized: () => {
        this.#initialized = true;
      },
      replacementReady: () =>
        this.#process !== process && !this.#isDisposed() ? this.ready() : undefined,
    });
  }

  async sendMessage(text: string): Promise<void> {
    if (this.#state !== "idle") throw new Error("code agent is already running");
    await this.#sendInput(text);
  }

  get hasLiveTurn(): boolean {
    return this.#state === "running" || this.#state === "interrupting";
  }

  get processId(): number | undefined {
    return this.#process.pid;
  }

  async #sendInput(text: string, options?: AgentNoticeOptions): Promise<void> {
    this.#notices.throwIfFailed();
    text = prepareAgentNotice(text, options, this.#state === "idle" ? "prompt" : "steer");
    this.#firstInput ??= text;
    if (this.#state === "idle") this.#beginNativeTurn();
    else this.#nativeTurnQueued = true;
    this.#setIdentity("unknown");
    await this.#process.send({
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      session_id: this.#sessionId,
    });
  }

  async notify(notice: string, options?: AgentNoticeOptions): Promise<void> {
    this.#notices.throwIfFailed();
    if (this.#state === "disposed" || this.#state === "interrupting") {
      throw new Error("code agent cannot accept a notification");
    }
    if (this.#state === "idle") {
      await this.#sendInput(notice, options);
      return;
    }
    await this.#notices.enqueue(notice, options);
  }

  subscribe(listener: (event: AgentRuntimeEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async readSessionIdentity(): Promise<AgentSessionIdentity> {
    return this.#identity ?? { sessionId: "", state: "unknown" };
  }

  async interrupt(): Promise<void> {
    if (this.#state === "idle" || this.#state === "disposed") return;
    if (this.#interrupt.isPending) return this.#interrupt.begin();
    const interrupted = this.#interrupt.begin();
    this.#state = "interrupting";
    try {
      this.#process.interrupt();
    } catch (error) {
      if (!this.#isDisposed()) this.#state = "running";
      this.#interrupt.fail(error instanceof Error ? error : new Error(String(error)));
    }
    return interrupted;
  }

  /** Claude Code's `stop_task` control request; only live tasks are sent. */
  async interruptSubagent(taskId: string): Promise<"interrupted" | "not_running"> {
    if (this.#state === "disposed" || !this.#tasks.has(taskId)) return "not_running";
    await this.#process.send({
      type: "control_request",
      request_id: `coforge-stop-task-${this.#nextSubagentStop++}`,
      request: { subtype: "stop_task", task_id: taskId },
    });
    return "interrupted";
  }

  async killTurnProcesses(window: AgentTurnProcessWindow): Promise<void> {
    await this.#process.killTurnProcesses(window);
  }

  onExit(listener: (exit?: AgentSessionExit) => void): () => void {
    return this.#exit.onExit(listener);
  }

  async dispose(options?: Readonly<{ cutoffAtMs?: number }>): Promise<void> {
    if (this.#state === "disposed") return;
    this.#state = "disposed";
    this.#notices.reject(new Error("code agent process closed before writing input"));
    this.#interrupt.fail(new Error("code agent process closed"));
    try {
      await this.#process.dispose(options);
      this.#finishClose(this.#process.exitInfo());
    } finally {
      await this.#removePrompt();
    }
  }

  #accept(record: Readonly<Record<string, unknown>>): void {
    if (this.#recoveryFailed || this.#state === "disposed") return;
    if (
      this.#state === "idle" &&
      ["stream_event", "assistant", "user"].includes(String(record.type))
    ) {
      if (!this.#nativeTurnQueued || !isClaudeNativeTurnStart(record)) return;
      this.#beginNativeTurn();
    }
    if (hasClaudeSessionProgress(record)) {
      this.#progressObserved = true;
      this.#firstInput = undefined;
    }
    const currentMainSession = isClaudeMainSessionRecord(record, this.#sessionId);
    if (record.type === "system" && record.parent_tool_use_id == null) {
      if (currentMainSession && record.subtype === "status" && record.status === "compacting") {
        this.#compacting = true;
        this.#emit({ type: "compaction-started", occurredAt: eventTime(record) });
      }
      if (currentMainSession && record.subtype === "compact_boundary") {
        this.#compacting = false;
        this.#deferredCompactionError = undefined;
        this.#emit({
          type: "compaction-finished",
          occurredAt: eventTime(record),
          ...compactBoundaryTokens(record),
        });
        this.#flushNotices();
      }
      const relayed = relayTaskLifecycle(record, this.#tasks, this.#subagentLineage);
      if (relayed) this.#emit(relayed);
    }
    if (record.type === "system" && record.subtype === "init") {
      const sessionId = readClaudeInitSessionId(
        record,
        this.#replacedSessionId,
        this.expectedSessionId,
        this.#sessionId,
      );
      if (sessionId === undefined) {
        this.#failRecovery();
        return;
      }
      // UNDOCUMENTED, observed with Claude Code 2.1.304 stream-json on 2026-10-20 (re-check when
      // raising the Claude Code version gate): a turn Claude Code starts by itself after a
      // background task opens with this session's top-level init; no ended turn's leftover is one.
      if (this.#state === "idle" && this.#resultObserved && record.parent_tool_use_id == null)
        this.#beginNativeTurn();
      this.#sessionId = sessionId;
      if (this.expectedSessionId !== undefined)
        this.#sessionReadyForNotices = sessionId === this.expectedSessionId;
      this.#setIdentity(this.expectedSessionId ? "resumable" : "empty");
      this.#nativeIdentityObserved = true;
      this.#reportIdentity();
      return;
    }
    if (record.type === "rate_limit_event") {
      const rateLimitSession = record.session_id === this.#sessionId ? this.#sessionId : undefined;
      const snapshot = this.#rateLimits.observe(record, rateLimitSession ?? this.#sessionId, {
        modelScope: currentMainSession && rateLimitSession !== undefined,
      });
      if (snapshot) this.#emit({ type: AGENT_RUNTIME_EVENT_TYPE.USAGE, snapshot });
      if (currentMainSession && record.session_id === this.#sessionId && this.#sessionId) {
        const available = claudeModelWindowAvailable(record);
        if (available) this.#emit(available);
      }
      return;
    }
    const refusal =
      currentMainSession &&
      this.#state === "running" &&
      this.#nativeIdentityObserved &&
      !this.#turnRefused &&
      claudeRefusalEvent(record);
    if (refusal) {
      this.#turnRefused = true;
      this.#deferredCompactionError = undefined;
      this.#emit(refusal);
    }
    if (record.type === "stream_event") {
      for (const streamed of this.#streamEvents.read(record)) this.#emit(streamed);
      return;
    }
    if (record.type === "assistant") {
      const { ids, events } = claudeAssistantEvents(record, this.#subagentLineage.of(record));
      if (record.parent_tool_use_id == null) {
        for (const id of ids) this.#outstandingTools.add(id);
      }
      for (const event of events) {
        if (event.type === "tool-start") this.#subagentLineage.rememberCall(event);
        if (event.type !== "error") this.#emit(event);
        else this.#acceptAssistantError(event, currentMainSession);
      }
      return;
    }
    if (record.type === "user") {
      const { ids, events } = claudeToolResults(record);
      let toolFinished = false;
      if (record.parent_tool_use_id == null)
        for (const id of ids) if (this.#outstandingTools.delete(id)) toolFinished = true;
      for (const event of events) this.#emit(event);
      if (toolFinished) this.#flushNotices();
      return;
    }
    if (record.type === "result") {
      if (!currentMainSession) return;
      if (
        !this.#nativeIdentityObserved ||
        !this.#sessionId ||
        (this.expectedSessionId && this.#sessionId !== this.expectedSessionId)
      ) {
        this.#failRecovery();
        return;
      }
      this.#reportIdentity();
      for (const event of this.#observations.read(record, this.#sessionId)) this.#emit(event);
      this.#sessionReadyForNotices = true;
      this.#resultObserved = true;
      this.#setIdentity("resumable");
      this.#compacting = false;
      const deferred = this.#deferredCompactionError;
      this.#deferredCompactionError = undefined;
      this.#outstandingTools.clear();
      this.#interrupt.settle();
      if (this.#state === "idle" && this.#nativeTurnQueued) this.#beginNativeTurn();
      if (this.#state !== "running" && this.#state !== "interrupting") return;
      const status =
        this.#state === "interrupting"
          ? "interrupted"
          : record.subtype === "success" && record.is_error !== true && !this.#turnRefused
            ? "completed"
            : "failed";
      this.#state = "idle";
      if (status === "failed" && deferred)
        this.#emit(
          this.#rateLimits.annotate(claudeCompactionFailure(record, deferred), this.#sessionId),
        );
      this.#emit({ type: "completed", status });
      this.#flushNotices();
    }
  }

  #acceptAssistantError(event: ClaudeFailureEvent, currentMainSession: boolean): void {
    const failure = this.#rateLimits.annotate(
      event,
      currentMainSession ? this.#sessionId : undefined,
    );
    if (currentMainSession) {
      if (this.#state === "running" && this.#compacting && isClaudeCompactionOverflow(failure)) {
        if (!this.#turnErrorReported && !this.#turnRefused)
          this.#deferredCompactionError ??= failure;
        return;
      }
      this.#turnErrorReported = true;
      this.#deferredCompactionError = undefined;
    }
    this.#emit(failure);
  }

  #reportIdentity(): void {
    const sessionId = this.#sessionId;
    if (!sessionId || !this.reportSessionId) return;
    // Serialize observations, not the event reader. A repeated turn-end report
    // confirms the reference, not that the provider flushed its transcript.
    this.#sessionReports = this.#sessionReports
      .then(async () => {
        await this.reportSessionId!(sessionId, this.#replacedSessionId);
      })
      .catch((error) => {
        this.#emit({
          type: "error",
          message: error instanceof Error ? error.message : "Claude session identity report failed",
        });
      });
  }

  #flushNotices(): void {
    if (this.#notices.failed || this.#state === "disposed" || this.#state === "interrupting")
      return;
    if (!this.#sessionReadyForNotices || this.#compacting || this.#outstandingTools.size > 0)
      return;
    this.#notices.flush((text, options) => this.#sendInput(text, options));
  }

  #emit(event: AgentRuntimeEvent): void {
    for (const listener of this.#listeners) listener(event);
  }

  #finishClose(exit?: AgentSessionExit): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#exit.finish(exit);
  }

  #setIdentity(state: AgentSessionIdentity["state"]): void {
    if (!this.#sessionId) return;
    if (this.#identity?.sessionId === this.#sessionId && this.#identity.state === state) return;
    this.#identity = { sessionId: this.#sessionId, state };
    this.#emit({ type: "session", identity: this.#identity });
  }

  /** Starts a turn while idle, consuming any queued native turn. */
  #beginNativeTurn(): void {
    this.#nativeTurnQueued = false;
    this.#turnRefused = false;
    this.#turnErrorReported = false;
    this.#compacting = false;
    this.#deferredCompactionError = undefined;
    this.#state = "running";
  }

  #isDisposed(): boolean {
    return this.#state === "disposed";
  }

  #failRecovery(): void {
    const error = new Error(
      this.expectedSessionId
        ? "Claude did not resume the requested session"
        : "Claude did not establish a valid session identity",
    );
    this.#recoveryFailed = true;
    this.#notices.reject(error);
    this.#emit({ type: "error", message: error.message });
    // Never block the event reader on process-tree cleanup.
    void this.dispose().catch(() => undefined);
  }
}
