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

/** One turn's provider projection: the events one update carries, and what the turn's end adds. */
export type AcpTurnReader = Readonly<{
  read(update: Readonly<Record<string, unknown>>): AgentRuntimeEvent[];
  end(): AgentRuntimeEvent[];
}>;

/** What a runtime supplies to its session state machine. */
export type AcpSessionProfile = Readonly<{
  /** The runtime's own name in every message a person reads. */
  label: string;
  /** Builds this runtime's process and client, wired to the session's own update and permission
   * sinks. */
  openTransport(sink: AcpSessionSink): AcpConnection;
  /**
   * Creates or resumes the native session after `initialize`, and applies the runtime's
   * configuration. Returns the session id and whether it continues an earlier conversation.
   */
  openSession(
    transport: AcpConnection,
    sessionId: string | undefined,
  ): Promise<{ sessionId: string; resumable: boolean; replacedSessionId?: string }>;
  /** One turn's event projection. */
  turn(): AcpTurnReader;
  /** Anything the runtime owns outside the process: an instruction mod, private files. */
  cleanup?(): Promise<void>;
  /** Replaces a failed turn's scrubbed provider detail, for a failure the runtime names itself.
   * Returning a message drops the provider's error code with it. */
  detailMessage?(detail: string): string | undefined;
  /** Runs after an interrupt settled the turn, for work the runtime owes at that point. */
  afterInterrupt?(): Promise<void>;
  /** The permission answer; the default allows once while the session is live. */
  permission?(request: RequestPermissionRequest, live: boolean): { outcome: PermissionAnswer };
}>;

/** What the transport wiring calls back into the session. */
export type AcpSessionSink = Readonly<{
  update(sessionId: string, update: Readonly<Record<string, unknown>>): void;
  permission(request: RequestPermissionRequest): { outcome: PermissionAnswer };
  /** The runtime wrote a `session/prompt` frame: this turn was submitted. */
  promptWritten(): void;
}>;

type PermissionAnswer = { outcome: "selected"; optionId: string } | { outcome: "cancelled" };

type Input = {
  text: string;
  options?: AgentNoticeOptions;
  admission: ReturnType<typeof Promise.withResolvers<void>>;
  attempted: boolean;
  updates: AcpTurnReader;
};

/**
 * One ACP runtime's session state machine: one native prompt at a time, the local queue that
 * custody admits into it, the turn's outcome, permission answers, notice cancellation, interrupt,
 * and the dispose/exit ladder. A runtime supplies only what its own protocol adds, through
 * `AcpSessionProfile`.
 */
export class AcpSession implements AgentSession {
  #transport: AcpConnection | undefined;
  readonly #listeners = new Set<(event: AgentRuntimeEvent) => void>();
  readonly #exitListeners = new Set<() => void>();
  readonly #queue: Input[] = [];
  #identity: AgentSessionIdentity | undefined;
  #active: Input | undefined;
  #turn: Promise<void> | undefined;
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
  ) {}

  async open() {
    try {
      const transport = this.profile.openTransport({
        update: (sessionId, update) => this.#update(sessionId, update),
        permission: (request) => this.#permission(request),
        promptWritten: () => {
          if (this.#active) this.#active.attempted = true;
        },
      });
      this.#transport = transport;
      transport.process.onClose(() => {
        this.#failed = true;
        void this.#terminate().then(() => this.#exitedNow());
      });
      await transport.initialize(this.timeoutMs);
      const opened = await this.profile.openSession(transport, this.options.sessionId);
      this.#identity = {
        sessionId: opened.sessionId,
        state: opened.resumable ? "resumable" : "empty",
      };
      await this.options.onSessionId?.(opened.sessionId, opened.replacedSessionId);
    } catch (error) {
      await this.dispose().catch(() => undefined);
      throw error;
    }
  }

  get hasLiveTurn() {
    return !this.#disposed && (!!this.#active || this.#queue.length > 0);
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
    this.#queue.push({
      text,
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
  }

  async #run(input: Input) {
    let status: "completed" | "interrupted" | "failed" = "failed";
    try {
      const response = await this.#requireTransport().connection.agent.request("session/prompt", {
        sessionId: this.#identity!.sessionId,
        prompt: [{ type: "text", text: input.text }],
      });
      if (response.stopReason === "end_turn") {
        this.#accept(input);
        status = "completed";
      } else if (response.stopReason === "cancelled") {
        input.admission.reject(
          new Error(`${this.profile.label} input cancelled; delivery outcome is unknown`),
        );
        status = "interrupted";
      } else {
        this.#accept(input);
        this.#emit(
          {
            type: "error",
            message: `${this.profile.label} prompt stopped: ${response.stopReason}`,
          },
          input,
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
          input,
        );
      if (!(error instanceof RequestError)) this.#failed = true;
    } finally {
      if (this.#active === input) {
        this.#active = undefined;
        for (const event of input.updates.end()) this.#emit(event, input);
        if (!this.#disposed) this.#emit({ type: "completed", status }, input);
        this.#startNext();
        if (this.#failed && !this.#disposed) void this.#terminate();
      }
    }
  }

  #update(sessionId: string, update: Readonly<Record<string, unknown>>) {
    const input = this.#active;
    if (this.#disposed || !input || sessionId !== this.#identity?.sessionId) return;
    const events = input.updates.read(update);
    if (
      events.some(
        (event) =>
          event.type === "text-delta" ||
          event.type === "thinking-delta" ||
          event.type === "tool-start" ||
          event.type === "tool-output" ||
          event.type === "tool-end",
      )
    ) {
      this.#accept(input);
    }
    for (const event of events) this.#emit(event, input);
  }

  #accept(input: Input) {
    input.admission.resolve();
    if (this.#identity && this.#identity.state !== "resumable") {
      this.#identity = { ...this.#identity, state: "resumable" };
      this.#emit({ type: "session", identity: this.#identity }, input);
    }
  }

  #permission(request: RequestPermissionRequest) {
    const live =
      !this.#disposed &&
      !this.#interrupting &&
      !!this.#active &&
      request.sessionId === this.#identity?.sessionId;
    if (this.profile.permission) return this.profile.permission(request, live);
    const allow = live ? request.options.find((option) => option.kind === "allow_once") : undefined;
    return {
      outcome: allow
        ? { outcome: "selected" as const, optionId: allow.optionId }
        : { outcome: "cancelled" as const },
    };
  }

  cancelPendingNotices() {
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
  }

  async interrupt() {
    if (this.#disposed) return;
    this.#interrupting = true;
    this.cancelPendingNotices();
    try {
      if (this.#active) {
        await this.#requireTransport().connection.agent.notify("session/cancel", {
          sessionId: this.#identity!.sessionId,
        });
        if (this.#turn) await this.bounded(this.#turn, this.timeoutMs);
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

  #emit(event: AgentRuntimeEvent, input?: Input) {
    const conversation = input?.options?.conversation ?? this.options.conversation;
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
