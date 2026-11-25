import type { RequestPermissionRequest } from "@agentclientprotocol/sdk/unstable";
import {
  AgentNoticeSuppressedError,
  type AgentNoticeOptions,
  type AgentRuntimeEvent,
  type AgentSession,
  type AgentSessionExit,
  type AgentSessionIdentity,
  type AgentSessionOptions,
  type AgentTurnProcessWindow,
  type AgentTurnTokenUsage,
} from "@coforge/agent";
import { RequestError } from "@agentclientprotocol/sdk/unstable";
import { acpPromptTokenUsage, acpUpdateTokenUsage } from "#src/acp-context-usage";
import { AGENT_RUNTIME_EVENT_TYPE } from "#src/contract";
import { asRecord } from "#src/json-record";
import { attachStderrExcerpt } from "#src/stderr-excerpt";
import type { AcpConnection } from "./connection";
import type { AcpNativeTurn, AcpSessionProfile } from "./profile";
import { acpPromptFailure, acpSteerResponseFailure, acpStopStatus } from "./prompt-failure";
import {
  acpCancelPendingNotices,
  acpHasAcceptanceActivity,
  acpRejectInput,
  acpReplayOpeningFrames,
  type AcpNativeTurnState,
  type AcpSessionInput,
  rememberCompletedPrompt,
} from "./session-turn";
import { resolveAcpPermission } from "./session-permission";
import { AcpSteering } from "./steering";
import { AcpTrailingUsageGate, acpIdleUsageUpdateEvents } from "./trailing-usage";
import { SessionExit } from "#src/session-exit";

type Input = AcpSessionInput;
type NativeTurn = AcpNativeTurnState;

export class AcpSession implements AgentSession {
  #transport: AcpConnection | undefined;
  readonly #listeners = new Set<(event: AgentRuntimeEvent) => void>();
  readonly #exit = new SessionExit();
  #processExit: AgentSessionExit | undefined;
  readonly #queue: Input[] = [];
  readonly #steering: AcpSteering | undefined;
  #identity: AgentSessionIdentity | undefined;
  #active: Input | undefined;
  #native: NativeTurn | undefined;
  #turn: Promise<void> | undefined;
  readonly #openingFrames: [string, Readonly<Record<string, unknown>>][] = [];
  #opening = true;
  readonly #completedPrompts = new Set<string>();
  #lastAdmission: Promise<void> = Promise.resolve();
  #generation = 0;
  #disposed = false;
  #failed = false;
  #interrupting = false;
  #dispose: Promise<void> | undefined;
  #termination: Promise<void> | undefined;
  #turnEmittedTokenUsage = false;
  readonly #trailingUsage = new AcpTrailingUsageGate();

  get steersBusyTurn(): boolean {
    return this.profile.steer !== undefined;
  }

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
            this.profile.steer?.unboundedRequest
              ? this.#requireTransport().connection.agent.request(method, params)
              : this.bounded(
                  this.#requireTransport().connection.agent.request(method, params),
                  this.timeoutMs,
                ),
          dispose: async () => {
            if (this.#transport?.process.exitCode === undefined) await this.dispose();
          },
          emit: (event, options) => this.#emit(event, options),
          markResumable: (options) => this.#markResumable(options),
          isDisposed: () => this.#disposed,
          onTokenUsage: (usage, options) => this.#emitTokenUsage(usage, options),
          turnFailure: (response) =>
            acpSteerResponseFailure(response, this.profile, this.#active?.updates),
          rpcFailure: (error) => acpPromptFailure(error, this.profile),
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
          if (this.#active && !this.#active.attempted) {
            this.#active.attempted = true;
            this.#active.options?.onPromptWritten?.();
          }
        },
      });
      this.#transport = transport;
      transport.process.onFailure((error) => {
        attachStderrExcerpt(transport.process, error);
        this.#failed = true;
        this.#trailingUsage.wake();
        if (!this.#native) return;
        this.#finishNative({
          promptId: this.#native.promptId,
          end: {
            status: "failed",
            error: { type: "error", message: error.message, providerErrorReason: "process_exit" },
          },
        });
      });
      transport.process.onClose((exit) => {
        this.#processExit = exit;
        this.#failed = true;
        this.#trailingUsage.wake();
        const settle = this.#turn ?? Promise.resolve();
        void settle.finally(() => this.#terminate().then(() => this.#exitedNow()));
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
      const process = this.#transport?.process;
      if (typeof process?.stderrExcerpt === "function") attachStderrExcerpt(process, error);
      throw error;
    }
  }

  get hasLiveTurn() {
    return !this.#disposed && (!!this.#active || !!this.#native || this.#queue.length > 0);
  }

  get processId(): number | undefined {
    return this.#transport?.process.pid;
  }

  sendMessage(text: string) {
    return this.notify(text);
  }

  notify(text: string, options?: AgentNoticeOptions): Promise<void> {
    const rejected = acpRejectInput(
      text,
      this.profile,
      this.#disposed || this.#failed || this.#interrupting,
    );
    if (rejected) return Promise.reject(rejected);
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
    for (let input = this.#queue.shift(); input; input = this.#queue.shift()) {
      if (input.options?.prepareSubmission) {
        const text = input.options.prepareSubmission("prompt");
        if (text === undefined) {
          input.admission.reject(new AgentNoticeSuppressedError());
          continue;
        }
        input.text = text;
      }
      this.#active = input;
      this.#turnEmittedTokenUsage = false;
      this.#turn = this.#run(input);
      if (this.profile.admissionTimeoutMs !== undefined) this.#armAdmissionTimeout(input);
      return;
    }
  }

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
    let promptResponse: unknown;
    let completedResponse: unknown;
    let errorTokenUsage: AgentTurnTokenUsage | undefined;
    let emittedPromptTokenUsage = false;
    const resolvePromptTokenUsage = () =>
      acpPromptTokenUsage(promptResponse) ??
      errorTokenUsage ??
      input.notificationTokenUsage ??
      input.updateTokenUsage;
    const emitPromptTokenUsage = (usage: AgentTurnTokenUsage | undefined) => {
      if (!usage || emittedPromptTokenUsage || this.#disposed) return;
      emittedPromptTokenUsage = true;
      this.#emitTokenUsage(usage, input.options);
    };
    try {
      const meta = input.promptId ? this.profile.promptMeta?.(input.promptId) : undefined;
      const response = await this.#requireTransport().connection.agent.request("session/prompt", {
        sessionId: this.#identity!.sessionId,
        prompt: [{ type: "text", text: input.text }],
        ...(meta ? { _meta: meta } : {}),
      });
      promptResponse = response;
      const stop = acpStopStatus(response.stopReason, this.profile);
      const inBand =
        stop.status === "completed" && !this.profile.steer?.settlesTurn
          ? input.updates.inBandFailure?.(asRecord(response) ?? {})
          : undefined;
      if (inBand !== undefined) {
        this.#accept(input);
        emitPromptTokenUsage(resolvePromptTokenUsage());
        this.#emit(
          typeof inBand === "string" ? { type: "error", message: inBand } : inBand,
          input.options,
        );
      } else if (stop.status === "completed") {
        this.#accept(input);
        completedResponse = response;
        status = "completed";
      } else if (stop.status === "interrupted") {
        input.admission.reject(
          new Error(`${this.profile.label} input cancelled; delivery outcome is unknown`),
        );
        status = "interrupted";
      } else {
        this.#accept(input);
        emitPromptTokenUsage(resolvePromptTokenUsage());
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
      if (rpcFailure) errorTokenUsage = acpPromptTokenUsage(error.data);
      if (rpcFailure && input.attempted) this.#accept(input);
      else
        input.admission.reject(
          new Error(
            input.attempted
              ? `${this.profile.label} input delivery outcome is unknown`
              : `${this.profile.label} rejected input before submission`,
          ),
        );
      if (!rpcFailure && this.#transport) attachStderrExcerpt(this.#transport.process, error);
      emitPromptTokenUsage(resolvePromptTokenUsage());
      if (!this.#disposed && !(this.#interrupting && !rpcFailure))
        this.#emit(acpPromptFailure(error, this.profile), input.options);
      if (!(error instanceof RequestError))
        if (this.#interrupting) status = "interrupted";
        else this.#failed = true;
    } finally {
      if (this.#active === input) {
        if (this.profile.steer?.unboundedRequest) {
          const steered = await this.#steering?.drain(completedResponse, input.options);
          if (steered && status === "completed") status = steered;
        }
        let promptTokenUsage = emittedPromptTokenUsage ? undefined : resolvePromptTokenUsage();
        if (
          !promptTokenUsage &&
          !this.#turnEmittedTokenUsage &&
          promptResponse !== undefined &&
          !input.sawUsageUpdate &&
          !this.#disposed &&
          !this.#failed &&
          !this.#interrupting &&
          this.profile.trailingUsageWaitMs !== undefined &&
          this.profile.trailingUsageWaitMs > 0
        ) {
          await this.#trailingUsage.wait(this.profile.trailingUsageWaitMs);
          promptTokenUsage = input.updateTokenUsage;
        }
        this.#active = undefined;
        if (input.promptId) rememberCompletedPrompt(this.#completedPrompts, input.promptId);
        this.#steering?.settle();
        for (const event of input.updates.end()) this.#emit(event, input.options);
        emitPromptTokenUsage(promptTokenUsage);
        if (!this.#disposed) this.#emit({ type: "completed", status }, input.options);
        this.#startNext();
        if (this.#failed && !this.#disposed) void this.#terminate();
      }
    }
  }

  #emitTokenUsage(usage: AgentTurnTokenUsage, options?: AgentNoticeOptions) {
    if (this.#disposed) return;
    this.#turnEmittedTokenUsage = true;
    this.#emit({ type: AGENT_RUNTIME_EVENT_TYPE.TOKEN_USAGE, usage }, options);
  }

  #update(sessionId: string, update: Readonly<Record<string, unknown>>) {
    if (this.#disposed || sessionId !== this.#identity?.sessionId) return;
    this.#project(update);
  }

  #notification(method: string, params: Readonly<Record<string, unknown>>) {
    if (this.#disposed) return;
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
      this.#accept(this.#active!);
    }
    if (promptId && this.profile.promptNotificationTokenUsage) {
      const notificationUsage = this.profile.promptNotificationTokenUsage(method, params, promptId);
      if (notificationUsage && this.#active)
        this.#active.notificationTokenUsage = notificationUsage;
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

  #ready() {
    this.#opening = false;
    acpReplayOpeningFrames(
      this.#openingFrames.splice(0),
      this.#identity?.sessionId,
      this.profile.steer?.nativeTurn,
      (method, params) => this.#dispatch(method, params),
    );
  }

  #project(update: Readonly<Record<string, unknown>>) {
    const input = this.#active;
    const turn = input ?? this.#native;
    if (!turn) {
      if (!this.#opening && !this.#disposed) {
        const idle = acpIdleUsageUpdateEvents(update, this.#turnEmittedTokenUsage);
        for (const event of idle.contextEvents) this.#emit(event);
        if (idle.tokenUsage) this.#emitTokenUsage(idle.tokenUsage);
      }
      return;
    }
    if (update.sessionUpdate === "usage_update") {
      turn.sawUsageUpdate = true;
      const updateTokens = acpUpdateTokenUsage(update);
      if (updateTokens) turn.updateTokenUsage = updateTokens;
      this.#trailingUsage.wake();
    }
    const events = turn.updates.read(update);
    if (input) {
      if (acpHasAcceptanceActivity(events)) this.#accept(input);
    } else if (events.length) this.#markResumable();
    for (const event of events) this.#emit(event, input?.options);
  }

  #startNative(promptId: string) {
    if (this.#completedPrompts.has(promptId) || this.#native?.promptId === promptId) return;
    this.#turnEmittedTokenUsage = false;
    this.#native = {
      promptId,
      updates: this.profile.turn(),
      settled: Promise.withResolvers<void>(),
    };
    this.#emit({ type: "progress" });
  }

  #finishNative(native: AcpNativeTurn) {
    rememberCompletedPrompt(this.#completedPrompts, native.promptId);
    const turn = this.#native;
    if (!turn || turn.promptId !== native.promptId) return;
    this.#native = undefined;
    turn.settled.resolve();
    this.#steering?.settle();
    for (const event of turn.updates.end()) this.#emit(event);
    const tokenUsage = native.end?.tokenUsage ?? turn.updateTokenUsage;
    if (tokenUsage && !this.#disposed) this.#emitTokenUsage(tokenUsage);
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
      !this.#failed &&
      !this.#interrupting &&
      request.sessionId === this.#identity?.sessionId;
    return resolveAcpPermission(request, live);
  }

  cancelPendingNotices() {
    this.#generation++;
    acpCancelPendingNotices(this.profile.label, this.#queue, this.#active);
    this.#steering?.rejectPending(`${this.profile.label} notice cancelled`);
  }

  async interrupt() {
    if (this.#disposed) return;
    this.#interrupting = true;
    this.#trailingUsage.wake();
    this.cancelPendingNotices();
    try {
      if (this.#active || this.#native) {
        const transport = this.#requireTransport();
        if (this.profile.cancelTurn) await this.profile.cancelTurn(transport);
        else
          await transport.connection.agent.notify("session/cancel", {
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

  async killTurnProcesses(window: AgentTurnProcessWindow): Promise<void> {
    await this.#transport?.process.killTurnProcesses(window);
  }

  async readSessionIdentity() {
    return this.#identity;
  }

  subscribe(listener: (event: AgentRuntimeEvent) => void) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  onExit(listener: (exit?: AgentSessionExit) => void) {
    return this.#exit.onExit(listener);
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
    this.#exit.finish(this.#processExit);
  }

  dispose(options?: Readonly<{ cutoffAtMs?: number }>): Promise<void> {
    this.#disposed = true;
    this.#trailingUsage.wake();
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
