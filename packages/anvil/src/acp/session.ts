import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";
import type {
  AgentNoticeOptions,
  AgentRuntimeEvent,
  AgentSession,
  AgentSessionIdentity,
  AgentSessionOptions,
} from "@coforge/agent";
import { RequestError } from "@agentclientprotocol/sdk";
import { asRecord, nonEmptyString } from "#src/json-record";
import { scrubRuntimeErrorText } from "#src/runtime-error-text";
import type { AcpConnection } from "./connection";
import type { AcpNativeTurn, AcpSessionProfile, AcpTurnReader } from "./profile";
import { AcpSteering } from "./steering";

type Input = {
  text: string;
  /** The id this session assigns the prompt, for a runtime that correlates its own updates. */
  promptId?: string;
  options?: AgentNoticeOptions;
  admission: ReturnType<typeof Promise.withResolvers<void>>;
  attempted: boolean;
  updates: AcpTurnReader;
};

type NativeTurn = {
  promptId: string;
  updates: AcpTurnReader;
  settled: ReturnType<typeof Promise.withResolvers<void>>;
};

const SEEN_LIMIT = 256;

/** Adds `value`, evicting the oldest entry once the set exceeds its bound. */
function remember(seen: Set<string>, value: string) {
  seen.add(value);
  if (seen.size > SEEN_LIMIT) seen.delete(seen.values().next().value!);
}

/**
 * One ACP runtime's session state machine: one native prompt at a time, the local queue that
 * custody admits into it, busy-turn insertion, the turn's outcome, permission answers, notice
 * cancellation, interrupt, and the dispose/exit ladder. A runtime supplies only what its own
 * protocol adds, through `AcpSessionProfile`.
 */
export class AcpSession implements AgentSession {
  #transport: AcpConnection | undefined;
  readonly #listeners = new Set<(event: AgentRuntimeEvent) => void>();
  readonly #exitListeners = new Set<() => void>();
  readonly #queue: Input[] = [];
  readonly #steering: AcpSteering | undefined;
  #identity: AgentSessionIdentity | undefined;
  #active: Input | undefined;
  #native: NativeTurn | undefined;
  #turn: Promise<void> | undefined;
  /** Native-turn notifications that arrived before the session was reported. */
  readonly #openingFrames: [string, Readonly<Record<string, unknown>>][] = [];
  #opening = true;
  /** Prompts this session already settled, so a late or replayed notification cannot revive one. */
  readonly #completedPrompts = new Set<string>();
  #lastAdmission: Promise<void> = Promise.resolve();
  #generation = 0;
  #disposed = false;
  #failed = false;
  #interrupting = false;
  #exited = false;
  #dispose: Promise<void> | undefined;
  #termination: Promise<void> | undefined;

  constructor(
    private readonly profile: AcpSessionProfile,
    private readonly options: AgentSessionOptions,
    private readonly timeoutMs: number,
    private readonly bounded: <T>(work: Promise<T>, timeoutMs: number) => Promise<T>,
  ) {
    this.#steering = profile.steer
      ? new AcpSteering(profile.label, profile.steer, {
          acceptsInput: () => !this.#disposed && !this.#failed && !this.#interrupting,
          sessionId: () => this.#identity!.sessionId,
          turnIsLive: () => !!this.#active || !!this.#native,
          generation: () => this.#generation,
          request: (method, params) =>
            this.bounded(
              this.#requireTransport().connection.agent.request(method, params),
              this.timeoutMs,
            ),
          dispose: () => this.dispose(),
          emit: (event, options) => this.#emit(event, options),
          markResumable: (options) => this.#markResumable(options),
        })
      : undefined;
  }

  async open() {
    try {
      const transport = this.profile.openTransport({
        update: (sessionId, update) => this.#update(sessionId, update),
        notification: (method, params) => this.#notification(method, params),
        permission: (request) => this.#permission(request),
        promptWritten: () => {
          if (this.#active) this.#active.attempted = true;
        },
      });
      this.#transport = transport;
      transport.process.onFailure((error) => {
        // A prompt's own rejection reports its failure; only a turn the runtime started has no
        // request left to settle it.
        if (!this.#native) return;
        this.#failed = true;
        this.#finishNative({
          promptId: this.#native.promptId,
          end: {
            status: "failed",
            error: { type: "error", message: error.message, providerErrorReason: "process_exit" },
          },
        });
      });
      transport.process.onClose(() => {
        this.#failed = true;
        void this.#terminate().then(() => this.#exitedNow());
      });
      const initialized = await transport.initialize(this.timeoutMs);
      await this.profile.beforeSession?.(transport, initialized);
      const opened = await this.profile.openSession(transport, this.options.sessionId, initialized);
      this.#identity = {
        sessionId: opened.sessionId,
        state: opened.resumable ? "resumable" : "empty",
      };
      await this.options.onSessionId?.(opened.sessionId, opened.replacedSessionId);
      this.#ready();
    } catch (error) {
      await this.dispose().catch(() => undefined);
      throw error;
    }
  }

  get hasLiveTurn() {
    return !this.#disposed && (!!this.#active || !!this.#native || this.#queue.length > 0);
  }

  sendMessage(text: string) {
    return this.notify(text);
  }

  notify(text: string, options?: AgentNoticeOptions): Promise<void> {
    if (this.#disposed || this.#failed || this.#interrupting)
      return Promise.reject(
        new Error(`${this.profile.label} cannot accept input before submission`),
      );
    const admission = Promise.withResolvers<void>();
    const prior = this.#lastAdmission;
    this.#lastAdmission = admission.promise.catch(() => undefined);
    if ((this.#active || this.#native) && this.#steering)
      return this.#steering.offer(text, options, admission, prior);
    this.#queue.push({
      text,
      promptId: this.profile.promptMeta ? crypto.randomUUID() : undefined,
      options,
      admission,
      attempted: false,
      updates: this.profile.turn(),
    });
    this.#startNext();
    return admission.promise;
  }

  #startNext() {
    if (this.#active || this.#disposed || this.#failed || this.#interrupting) return;
    const input = this.#queue.shift();
    if (!input) return;
    this.#active = input;
    this.#turn = this.#run(input);
    if (this.profile.admissionTimeoutMs !== undefined) this.#armAdmissionTimeout(input);
  }

  /**
   * An input that waits past the runtime's admission deadline has an unknown delivery outcome.
   * Close the native session before rejecting, so a late native acceptance cannot race the
   * daemon's retry.
   */
  #armAdmissionTimeout(input: Input) {
    const timer = setTimeout(() => {
      if (this.#active !== input) return;
      void this.dispose();
      input.admission.reject(new Error(`${this.profile.label} input delivery outcome is unknown`));
    }, this.profile.admissionTimeoutMs!);
    input.admission.promise.then(
      () => clearTimeout(timer),
      () => clearTimeout(timer),
    );
  }

  async #run(input: Input) {
    let status: "completed" | "interrupted" | "failed" = "failed";
    try {
      const meta = input.promptId ? this.profile.promptMeta?.(input.promptId) : undefined;
      const response = await this.#requireTransport().connection.agent.request("session/prompt", {
        sessionId: this.#identity!.sessionId,
        prompt: [{ type: "text", text: input.text }],
        ...(meta ? { _meta: meta } : {}),
      });
      const stop = this.profile.stopStatus?.(response.stopReason) ?? {
        status:
          response.stopReason === "end_turn"
            ? ("completed" as const)
            : response.stopReason === "cancelled"
              ? ("interrupted" as const)
              : ("failed" as const),
      };
      if (stop.status === "completed") {
        this.#accept(input);
        status = "completed";
      } else if (stop.status === "interrupted") {
        input.admission.reject(
          new Error(`${this.profile.label} input cancelled; delivery outcome is unknown`),
        );
        status = "interrupted";
      } else {
        this.#accept(input);
        this.#emit(
          {
            type: "error",
            message: stop.error ?? `${this.profile.label} prompt stopped: ${response.stopReason}`,
          },
          input.options,
        );
      }
    } catch (error) {
      const rpcFailure = error instanceof RequestError;
      if (rpcFailure && input.attempted) this.#accept(input);
      else
        input.admission.reject(
          new Error(
            input.attempted
              ? `${this.profile.label} input delivery outcome is unknown`
              : `${this.profile.label} rejected input before submission`,
          ),
        );
      // A terminal RPC failure is an accepted failed turn. Only transport loss leaves delivery
      // unknown; neither outcome permits automatic resending or notice-undelivered.
      const data = rpcFailure ? asRecord(error.data) : undefined;
      const detail =
        nonEmptyString(data?.detail) ??
        nonEmptyString(data?.message) ??
        (rpcFailure ? nonEmptyString(error.data) : undefined) ??
        (error instanceof Error ? error.message : `${this.profile.label} prompt failed`);
      const named = this.profile.detailMessage?.(detail);
      if (!this.#disposed)
        this.#emit(
          named
            ? { type: "error", message: named }
            : {
                type: "error",
                message: scrubRuntimeErrorText(detail),
                ...(rpcFailure ? { providerErrorCode: String(error.code) } : {}),
              },
          input.options,
        );
      if (!(error instanceof RequestError)) this.#failed = true;
    } finally {
      if (this.#active === input) {
        this.#active = undefined;
        if (input.promptId) remember(this.#completedPrompts, input.promptId);
        this.#steering?.settle();
        for (const event of input.updates.end()) this.#emit(event, input.options);
        if (!this.#disposed) this.#emit({ type: "completed", status }, input.options);
        this.#startNext();
        if (this.#failed && !this.#disposed) void this.#terminate();
      }
    }
  }

  #update(sessionId: string, update: Readonly<Record<string, unknown>>) {
    if (this.#disposed || sessionId !== this.#identity?.sessionId) return;
    this.#project(update);
  }

  #notification(method: string, params: Readonly<Record<string, unknown>>) {
    if (this.#disposed) return;
    // Until the session is reported its id is unknown, so a native turn's frames are kept and
    // classified once it is.
    if (this.#opening) {
      if (this.profile.steer?.nativeTurn?.(method, params, undefined))
        this.#openingFrames.push([method, params]);
      return;
    }
    this.#dispatch(method, params);
  }

  #dispatch(method: string, params: Readonly<Record<string, unknown>>) {
    if (typeof params.sessionId === "string" && params.sessionId !== this.#identity?.sessionId)
      return;
    const promptId = this.#active?.promptId;
    if (promptId && this.profile.promptAdmitted?.(method, params, promptId)) {
      // The runtime listed or started the prompt it was given: native acceptance, before any
      // output. Without it a slow first token would look like an unanswered input.
      this.#accept(this.#active!);
    }
    const update = asRecord(params.update);
    if (update) this.#project(update);
    const steer = this.profile.steer;
    if (!steer) return;
    if (this.#steering?.outcome(method, params)) return;
    const native = steer.nativeTurn?.(method, params, this.#active?.promptId);
    if (!native) return;
    if (native.end) this.#finishNative(native);
    else this.#startNative(native.promptId);
  }

  /**
   * Replays what arrived while the session was being reported, in arrival order. A native turn
   * that both started and ended then is not revived: its queue snapshot must not reopen a turn
   * whose `turn_completed` already arrived.
   */
  #ready() {
    this.#opening = false;
    const frames = this.#openingFrames.splice(0);
    const ended = new Set<string>();
    for (const [method, params] of frames) {
      const native = this.profile.steer?.nativeTurn?.(method, params, undefined);
      if (native?.end) ended.add(native.promptId);
    }
    for (const [method, params] of frames) {
      if (typeof params.sessionId === "string" && params.sessionId !== this.#identity?.sessionId)
        continue;
      const native = this.profile.steer?.nativeTurn?.(method, params, undefined);
      if (native && !native.end && ended.has(native.promptId)) continue;
      this.#dispatch(method, params);
    }
  }

  #project(update: Readonly<Record<string, unknown>>) {
    const input = this.#active;
    const turn = input ?? this.#native;
    if (!turn) return;
    const events = turn.updates.read(update);
    if (input) {
      if (
        events.some(
          (event) =>
            event.type === "text-delta" ||
            event.type === "thinking-delta" ||
            event.type === "tool-start" ||
            event.type === "tool-output" ||
            event.type === "tool-end",
        )
      )
        this.#accept(input);
    } else if (events.length) this.#markResumable();
    for (const event of events) this.#emit(event, input?.options);
  }

  #startNative(promptId: string) {
    if (this.#completedPrompts.has(promptId) || this.#native?.promptId === promptId) return;
    this.#native = {
      promptId,
      updates: this.profile.turn(),
      settled: Promise.withResolvers<void>(),
    };
    this.#emit({ type: "progress" });
  }

  #finishNative(native: AcpNativeTurn) {
    remember(this.#completedPrompts, native.promptId);
    const turn = this.#native;
    if (!turn || turn.promptId !== native.promptId) return;
    this.#native = undefined;
    turn.settled.resolve();
    this.#steering?.settle();
    for (const event of turn.updates.end()) this.#emit(event);
    if (native.end?.error && !this.#disposed) this.#emit(native.end.error);
    if (!this.#disposed) this.#emit({ type: "completed", status: native.end!.status });
    this.#startNext();
  }

  #accept(input: Input) {
    input.admission.resolve();
    this.#markResumable(input.options);
  }

  #markResumable(options?: AgentNoticeOptions) {
    if (this.#identity && this.#identity.state !== "resumable") {
      this.#identity = { ...this.#identity, state: "resumable" };
      this.#emit({ type: "session", identity: this.#identity }, options);
    }
  }

  #permission(request: RequestPermissionRequest) {
    const live =
      !this.#disposed &&
      !this.#interrupting &&
      !!this.#active &&
      request.sessionId === this.#identity?.sessionId;
    const allow = live ? request.options.find((option) => option.kind === "allow_once") : undefined;
    return {
      outcome: allow
        ? { outcome: "selected" as const, optionId: allow.optionId }
        : { outcome: "cancelled" as const },
    };
  }

  cancelPendingNotices() {
    this.#generation++;
    for (const input of this.#queue.splice(0))
      input.admission.reject(
        new Error(`${this.profile.label} queued input cancelled before submission`),
      );
    this.#active?.admission.reject(
      new Error(
        this.#active.attempted
          ? `${this.profile.label} input cancelled; delivery outcome is unknown`
          : `${this.profile.label} input cancelled before submission`,
      ),
    );
    this.#steering?.rejectPending(`${this.profile.label} notice cancelled`);
  }

  async interrupt() {
    if (this.#disposed) return;
    this.#interrupting = true;
    this.cancelPendingNotices();
    try {
      if (this.#active || this.#native) {
        await this.#requireTransport().connection.agent.notify("session/cancel", {
          sessionId: this.#identity!.sessionId,
        });
        if (this.#active && this.#turn) await this.bounded(this.#turn, this.timeoutMs);
        if (this.#native) await this.bounded(this.#native.settled.promise, this.timeoutMs);
      }
      await this.profile.afterInterrupt?.();
    } catch (error) {
      await this.dispose();
      throw error;
    } finally {
      this.#interrupting = false;
    }
  }

  async readSessionIdentity() {
    return this.#identity;
  }

  subscribe(listener: (event: AgentRuntimeEvent) => void) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  onExit(listener: () => void) {
    if (this.#exited) queueMicrotask(listener);
    else this.#exitListeners.add(listener);
    return () => this.#exitListeners.delete(listener);
  }

  #emit(event: AgentRuntimeEvent, options?: AgentNoticeOptions) {
    const conversation = options?.conversation ?? this.options.conversation;
    for (const listener of this.#listeners)
      listener(conversation ? { ...event, conversation } : event);
  }

  #requireTransport() {
    const transport = this.#transport;
    if (!transport) throw new Error(`${this.profile.label} session is not open`);
    return transport;
  }

  #terminate() {
    return (this.#termination ??= this.dispose().catch(() => {
      this.#emit({ type: "error", message: `${this.profile.label} process cleanup failed` });
    }));
  }

  #exitedNow() {
    this.#exited = true;
    for (const listener of this.#exitListeners) listener();
    this.#exitListeners.clear();
  }

  dispose(options?: Readonly<{ cutoffAtMs?: number }>): Promise<void> {
    this.#disposed = true;
    this.cancelPendingNotices();
    this.#steering?.clear();
    this.#native?.settled.resolve();
    this.#native = undefined;
    this.#dispose ??= this.#close(options);
    return this.#dispose;
  }

  async #close(options?: Readonly<{ cutoffAtMs?: number }>) {
    try {
      await this.#transport?.dispose(options);
    } finally {
      await this.profile.cleanup?.();
    }
  }
}
