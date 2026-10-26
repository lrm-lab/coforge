import type { ClaudeTurnHost } from "./host";
import type {
  AgentSession,
  AgentSessionIdentity,
  AgentSessionOptions,
  AgentRuntimeEvent,
} from "@coforge/agent";
import { AGENT_RUNTIME_EVENT_TYPE } from "#src/contract";
import { InterruptTracker } from "#src/interrupt-tracker";
import { asRecord, eventTime } from "#src/json-record";
import type { JsonlProcess } from "#src/jsonl-process";
import type { SessionState, SessionInitialization, PendingNotice } from "./session-state";
import { initializeClaudeSession } from "./initialize";
import { ClaudeStreamEvents } from "./stream-events";
import { claudeAssistantEvents, claudeToolResults } from "./message-events";
import { ClaudeSubagentLineage } from "./subagent-lineage";
import { ClaudeRateLimitState } from "./rate-limit";
import { ClaudeSessionObservations } from "./observations";
import { relayTaskLifecycle, taskProgressEvent } from "./task-lifecycle";

export class ClaudeCodeAgentSession implements AgentSession {
  #process: JsonlProcess;
  readonly #exitListeners = new Set<() => void>();
  #closed = false;
  #firstInput: string | undefined;
  #progressObserved = false;
  #replacedSessionId: string | undefined;
  readonly #removePrompt: () => Promise<void>;
  readonly #listeners = new Set<(event: AgentRuntimeEvent) => void>();
  #state: SessionState = "idle";
  #nativeTurnQueued = false;
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
  /** Non-ambient tasks announced by `task_started` and not yet ended, by task id, with the tool
   * call each belongs to; subagent types live in `#subagentLineage`. */
  readonly #tasks = new Map<string, string | undefined>();
  readonly #subagentLineage = new ClaudeSubagentLineage();
  readonly #streamEvents: ClaudeStreamEvents;
  #inputFailure: Error | undefined;
  #recoveryFailed = false;
  readonly #outstandingTools = new Set<string>();
  readonly #waitingNotices: PendingNotice[] = [];
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
    let missing = false;
    let otherDiagnostic = false;
    let failure: Error | undefined;
    process.onStderr((line) => {
      // This native diagnostic is used rather than an SDK existence query. Match the entire
      // selected-ID line, never arbitrary provider/model output.
      if (
        this.expectedSessionId &&
        line.trim() === `No conversation found with session ID: ${this.expectedSessionId}`
      )
        missing = true;
      else if (line.trim()) otherDiagnostic = true;
    });
    process.onRecord((record) => {
      if (this.#process !== process) return;
      if (
        this.expectedSessionId &&
        !this.#progressObserved &&
        !this.#recoveryFailed &&
        record.type === "result" &&
        record.subtype === "error_during_execution" &&
        record.is_error === true &&
        Array.isArray(record.errors) &&
        record.errors.length === 1 &&
        record.errors[0] === `No conversation found with session ID: ${this.expectedSessionId}`
      ) {
        missing = true;
        return;
      }
      this.#accept(record);
    });
    process.onFailure((error) => {
      failure = error;
      if (error.message !== "code agent process exited unexpectedly") {
        this.#interrupt.fail(error);
        this.#rejectWaitingNotices(error);
        this.#emit({ type: "error", message: error.message });
      }
    });
    process.onClose(() => {
      if (this.#process !== process) return;
      if (
        missing &&
        !otherDiagnostic &&
        failure?.message === "code agent process exited unexpectedly" &&
        this.expectedSessionId &&
        !this.#replacedSessionId &&
        !this.#progressObserved &&
        !this.#recoveryFailed &&
        this.#state !== "disposed" &&
        this.spawnFresh
      ) {
        this.#replacedSessionId = this.expectedSessionId;
        this.expectedSessionId = undefined;
        this.#initialized = false;
        this.#nativeIdentityObserved = false;
        void this.#startFresh().catch((error: unknown) => {
          this.#rejectWaitingNotices(error instanceof Error ? error : new Error(String(error)));
          this.#emit({ type: "error", message: "Claude fresh session launch failed" });
          void this.dispose().catch(() => undefined);
        });
        return;
      }
      if (failure && this.#state !== "disposed") {
        // Every close reaches here through the same sentinel message,
        // whether the process was disposed intentionally or not; only the
        // "not disposed" branch above already excludes a requested stop.
        // Whether this reads as a crash (vs. an ordinary error) is the
        // daemon core's call, made from this fact at the moment the process
        // actually exits (agent-runtime/runtime-error-activity.ts).
        this.#emit({ type: "error", message: failure.message });
      }
      this.#interrupt.fail(failure ?? new Error("code agent process closed during interrupt"));
      this.#rejectWaitingNotices(new Error("code agent process closed before writing input"));
      // Fire and forget: the close path has nothing to do with a cleanup failure, and `dispose`
      // awaits the same removal and reports it.
      void this.#removePrompt().catch(() => {});
      this.#finishClose();
    });
  }

  async #startFresh(): Promise<void> {
    const firstInput = this.#firstInput;
    const fresh = this.spawnFresh!();
    this.#process = fresh.process;
    this.#sessionId = fresh.sessionId;
    // The old process's tasks never report again: end each one, so the daemon stops counting it.
    for (const [taskId, toolUseId] of this.#tasks)
      this.#emit(
        taskProgressEvent(
          "notification",
          taskId,
          toolUseId,
          this.#subagentLineage.typeOf(toolUseId),
          "stopped",
        ),
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

  async #sendInput(text: string): Promise<void> {
    if (this.#inputFailure) throw this.#inputFailure;
    this.#firstInput ??= text;
    // Reserve the turn before writing; a native result can arrive during flush.
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

  async notify(notice: string): Promise<void> {
    if (this.#inputFailure) throw this.#inputFailure;
    if (this.#state === "disposed" || this.#state === "interrupting") {
      throw new Error("code agent cannot accept a notification");
    }
    if (this.#state === "idle") {
      await this.#sendInput(notice);
      return;
    }
    // Do not inject into an arbitrary thinking/tool execution instant. Only a
    // native tool-batch, compact, or result boundary drains these pending calls.
    await new Promise<void>((resolve, reject) => {
      this.#waitingNotices.push({ text: notice, resolve, reject });
    });
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

  onExit(listener: () => void): () => void {
    if (this.#closed) {
      queueMicrotask(listener);
      return () => undefined;
    }
    this.#exitListeners.add(listener);
    return () => this.#exitListeners.delete(listener);
  }

  async dispose(options?: Readonly<{ cutoffAtMs?: number }>): Promise<void> {
    if (this.#state === "disposed") return;
    this.#state = "disposed";
    this.#rejectWaitingNotices(new Error("code agent process closed before writing input"));
    this.#interrupt.fail(new Error("code agent process closed"));
    try {
      await this.#process.dispose(options);
      this.#finishClose();
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
      const nativeStart =
        record.parent_tool_use_id == null &&
        (record.type === "assistant" ||
          (record.type === "stream_event" && asRecord(record.event)?.type === "message_start"));
      if (!this.#nativeTurnQueued || !nativeStart) return;
      this.#beginNativeTurn();
    }
    if (
      ["stream_event", "assistant", "user", "result"].includes(String(record.type)) ||
      (record.type === "system" && record.subtype === "init")
    ) {
      this.#progressObserved = true;
      this.#firstInput = undefined;
    }
    if (record.type === "system" && record.parent_tool_use_id == null) {
      if (record.subtype === "status" && record.status === "compacting") {
        // Report the raw signal every time; the daemon core de-dupes repeated "compacting"
        // status lines into a single reported episode (agent-runtime/phase-tracker.ts).
        // This flag only gates queued notification delivery below.
        this.#compacting = true;
        this.#emit({ type: "compaction-started", occurredAt: eventTime(record) });
      }
      if (record.subtype === "compact_boundary") {
        this.#compacting = false;
        this.#emit({ type: "compaction-finished", occurredAt: eventTime(record) });
        this.#flushNotices();
      }
      const relayed = relayTaskLifecycle(record, this.#tasks, this.#subagentLineage);
      if (relayed) this.#emit(relayed);
    }
    if (record.type === "system" && record.subtype === "init") {
      if (
        typeof record.session_id !== "string" ||
        !record.session_id.trim() ||
        record.session_id === this.#replacedSessionId ||
        (this.expectedSessionId && record.session_id !== this.expectedSessionId) ||
        (!this.expectedSessionId &&
          this.#sessionId !== undefined &&
          record.session_id !== this.#sessionId)
      ) {
        this.#failRecovery();
        return;
      }
      // UNDOCUMENTED, observed with Claude Code 2.1.304 stream-json on 2026-10-20 (re-check when
      // raising the Claude Code version gate): a turn Claude Code starts by itself after a
      // background task opens with this session's top-level init; no ended turn's leftover is one.
      if (this.#state === "idle" && this.#resultObserved && record.parent_tool_use_id == null)
        this.#beginNativeTurn();
      if (typeof record.session_id === "string" && record.session_id !== this.#sessionId) {
        this.#sessionId = record.session_id;
      }
      if (this.expectedSessionId !== undefined)
        this.#sessionReadyForNotices = record.session_id === this.expectedSessionId;
      this.#setIdentity(this.expectedSessionId ? "resumable" : "empty");
      this.#nativeIdentityObserved = true;
      this.#reportIdentity();
      return;
    }
    if (record.type === "rate_limit_event") {
      const snapshot = this.#rateLimits.observe(record, this.#sessionId);
      if (snapshot) this.#emit({ type: AGENT_RUNTIME_EVENT_TYPE.USAGE, snapshot });
      return;
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
        this.#emit(
          event.type === "error" ? this.#rateLimits.annotate(event, this.#sessionId) : event,
        );
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
      if (record.parent_tool_use_id != null) return;
      if (
        !this.#nativeIdentityObserved ||
        !this.#sessionId ||
        (this.expectedSessionId && this.#sessionId !== this.expectedSessionId)
      ) {
        this.#failRecovery();
        return;
      }
      this.#reportIdentity();
      for (const event of this.#observations.read(record)) this.#emit(event);
      this.#sessionReadyForNotices = true;
      this.#resultObserved = true;
      this.#setIdentity("resumable");
      this.#compacting = false;
      this.#outstandingTools.clear();
      this.#interrupt.settle();
      if (this.#state !== "running" && this.#state !== "interrupting") return;
      const interrupted = this.#state === "interrupting";
      this.#state = "idle";
      this.#emit({
        type: "completed",
        // A completed agent loop can still carry an API failure in is_error.
        status: interrupted
          ? "interrupted"
          : record.subtype === "success" && record.is_error !== true
            ? "completed"
            : "failed",
      });
      this.#flushNotices();
    }
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
    if (this.#inputFailure || this.#state === "disposed" || this.#state === "interrupting") return;
    if (!this.#sessionReadyForNotices || this.#compacting || this.#outstandingTools.size > 0)
      return;
    // Written acceptance, not confirmation of model processing.
    for (const notice of this.#waitingNotices.splice(0)) {
      void this.#sendInput(notice.text).then(notice.resolve, notice.reject);
    }
  }

  #emit(event: AgentRuntimeEvent): void {
    for (const listener of this.#listeners) listener(event);
  }

  #finishClose(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const listener of this.#exitListeners) listener();
    this.#exitListeners.clear();
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
    this.#rejectWaitingNotices(error);
    this.#emit({ type: "error", message: error.message });
    // Never block the event reader on process-tree cleanup.
    void this.dispose().catch(() => undefined);
  }

  #rejectWaitingNotices(error: Error): void {
    this.#inputFailure ??= error;
    for (const notice of this.#waitingNotices.splice(0)) notice.reject(error);
  }
}
