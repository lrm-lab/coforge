import {
  RequestError,
  type SessionConfigOption,
  type RequestPermissionRequest,
} from "@agentclientprotocol/sdk";
import type {
  AgentNoticeOptions,
  AgentRuntimeEvent,
  AgentSession,
  AgentSessionIdentity,
  AgentSessionOptions,
} from "@coforge/agent";
import { RuntimeModelNotFoundError } from "#src/contract";
import { asRecord, nonEmptyString } from "#src/json-record";
import { scrubRuntimeErrorText } from "#src/runtime-error-text";
import { DshConnection, DSH_ACP_TIMEOUT_MS, dshBounded } from "./connection";
import { dshCatalogFromConfig } from "./catalog";
import { DshTurnEvents } from "./update-events";
import type { DshLaunchFiles, DshProviderOptions } from "./host";

type Input = {
  text: string;
  options?: AgentNoticeOptions;
  admission: ReturnType<typeof Promise.withResolvers<void>>;
  attempted: boolean;
  updates: DshTurnEvents;
};

/** DSH's turn failure when no DeepSeek key is configured. It is reported as a plain unset key, which
 * the Computer files with every other runtime that needs a person to sign in; DSH's own text names
 * its internal credential service and is not shown. */
const DSH_MISSING_KEY = /\bno API key for provider route\b/i;
export const DSH_MISSING_KEY_MESSAGE = "DeepSeek API key is not set";

/** One native prompt at a time; local queue custody is never native acceptance. */
export class DshSession implements AgentSession {
  readonly #transport: DshConnection;
  readonly #listeners = new Set<(event: AgentRuntimeEvent) => void>();
  readonly #exitListeners = new Set<() => void>();
  readonly #queue: Input[] = [];
  readonly #timeoutMs: number;
  #identity: AgentSessionIdentity | undefined;
  #active: Input | undefined;
  #turn: Promise<void> | undefined;
  #disposed = false;
  #failed = false;
  #interrupting = false;
  #exited = false;
  #dispose: Promise<void> | undefined;
  #termination: Promise<void> | undefined;
  #cleanup: Promise<void> | undefined;
  #instructionsInvalid = false;

  constructor(
    command: readonly string[],
    private readonly options: AgentSessionOptions,
    private readonly providerOptions: DshProviderOptions,
    private readonly files: DshLaunchFiles,
  ) {
    this.#timeoutMs = providerOptions.acpTimeoutMs ?? DSH_ACP_TIMEOUT_MS;
    this.#transport = new DshConnection(
      command,
      options.agentWorkspaceDirectory,
      providerOptions.host.buildEnvironment(options),
      providerOptions.host,
      files.patchPath,
      (sessionId, update) => this.#update(sessionId, update),
      (request) => this.#permission(request),
      () => {
        if (this.#active) this.#active.attempted = true;
      },
    );
    this.#transport.process.onStderr((line) => {
      if (line.includes("DSH CoForge instructions must be a string"))
        this.#instructionsInvalid = true;
    });
    this.#transport.process.onClose(() => {
      this.#failed = true;
      void this.#terminate().then(() => this.#exitedNow());
    });
  }

  async open() {
    try {
      const agent = this.#transport.connection.agent;
      await this.#transport.initialize(this.#timeoutMs);
      const cwd = this.options.agentWorkspaceDirectory;
      const resuming =
        this.options.sessionId !== undefined && this.options.sessionMode !== "create";
      const state = resuming
        ? await this.#bounded(
            agent.request("session/resume", {
              sessionId: this.options.sessionId!,
              cwd,
              mcpServers: [],
            }),
          )
        : await this.#bounded(agent.request("session/new", { cwd, mcpServers: [] }));
      const sessionId = resuming
        ? this.options.sessionId!
        : "sessionId" in state
          ? state.sessionId
          : undefined;
      if (typeof sessionId !== "string" || !sessionId.trim())
        throw new Error("DSH did not create a session");
      this.#identity = { sessionId, state: resuming ? "resumable" : "empty" };
      const config: SessionConfigOption[] = state.configOptions ?? [];
      const model = this.options.runtime?.model;
      if (model && model !== "default") {
        if (!dshCatalogFromConfig(config).models.some((entry) => entry.id === model))
          throw new RuntimeModelNotFoundError(model);
        await this.#bounded(
          agent.request("session/set_config_option", {
            sessionId,
            configId: "model",
            value: model,
          }),
        );
      }
      const reasoning = this.options.runtime?.reasoning;
      if (reasoning)
        await this.#bounded(
          agent.request("session/set_config_option", {
            sessionId,
            configId: "reasoning_effort",
            value: reasoning,
          }),
        );
      await this.options.onSessionId?.(sessionId);
    } catch (error) {
      if (this.#instructionsInvalid)
        throw new Error("DSH startup failed: required CoForge instructions must be a string", {
          cause: error,
        });
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
      return Promise.reject(new Error("DSH cannot accept input before submission"));
    const admission = Promise.withResolvers<void>();
    this.#queue.push({
      text,
      options,
      admission,
      attempted: false,
      updates: new DshTurnEvents(this.providerOptions.host),
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
      const response = await this.#transport.connection.agent.request("session/prompt", {
        sessionId: this.#identity!.sessionId,
        prompt: [{ type: "text", text: input.text }],
      });
      if (response.stopReason === "end_turn") {
        this.#accept(input);
        status = "completed";
      } else if (response.stopReason === "cancelled") {
        input.admission.reject(new Error("DSH input cancelled; delivery outcome is unknown"));
        status = "interrupted";
      } else {
        this.#accept(input);
        this.#emit({ type: "error", message: `DSH prompt stopped: ${response.stopReason}` }, input);
      }
    } catch (error) {
      const rpcFailure = error instanceof RequestError;
      if (rpcFailure && input.attempted) this.#accept(input);
      else
        input.admission.reject(
          new Error(
            input.attempted
              ? "DSH input delivery outcome is unknown"
              : "DSH rejected input before submission",
          ),
        );
      // A terminal RPC failure is an accepted failed turn. Only transport loss leaves delivery
      // unknown; neither outcome permits automatic resending or notice-undelivered.
      const data = rpcFailure ? asRecord(error.data) : undefined;
      const detail =
        nonEmptyString(data?.detail) ??
        nonEmptyString(data?.message) ??
        (rpcFailure ? nonEmptyString(error.data) : undefined) ??
        (error instanceof Error ? error.message : "DSH prompt failed");
      // A missing key carries no JSON-RPC code: its generic "internal error" code would stand in
      // for the class the Computer derives from the message.
      if (!this.#disposed)
        this.#emit(
          DSH_MISSING_KEY.test(detail)
            ? { type: "error", message: DSH_MISSING_KEY_MESSAGE }
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
    const allow =
      !this.#disposed &&
      !this.#interrupting &&
      !!this.#active &&
      request.sessionId === this.#identity?.sessionId
        ? request.options.find((option) => option.kind === "allow_once")
        : undefined;
    return {
      outcome: allow
        ? { outcome: "selected" as const, optionId: allow.optionId }
        : { outcome: "cancelled" as const },
    };
  }
  cancelPendingNotices() {
    for (const input of this.#queue.splice(0))
      input.admission.reject(new Error("DSH queued input cancelled before submission"));
    this.#active?.admission.reject(
      new Error(
        this.#active.attempted
          ? "DSH input cancelled; delivery outcome is unknown"
          : "DSH input cancelled before submission",
      ),
    );
  }
  async interrupt() {
    if (this.#disposed) return;
    this.#interrupting = true;
    this.cancelPendingNotices();
    try {
      if (this.#active) {
        await this.#transport.connection.agent.notify("session/cancel", {
          sessionId: this.#identity!.sessionId,
        });
        if (this.#turn) await this.#bounded(this.#turn);
      }
      await this.#cleanupFiles();
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
  #terminate() {
    return (this.#termination ??= this.dispose().catch(() => {
      this.#emit({ type: "error", message: "DSH process cleanup failed" });
    }));
  }
  #exitedNow() {
    this.#exited = true;
    for (const listener of this.#exitListeners) listener();
    this.#exitListeners.clear();
  }
  #bounded<T>(work: Promise<T>) {
    return dshBounded(work, this.#timeoutMs);
  }
  #cleanupFiles() {
    return (this.#cleanup ??= this.files.cleanup());
  }
  dispose(options?: Readonly<{ cutoffAtMs?: number }>): Promise<void> {
    this.#disposed = true;
    this.cancelPendingNotices();
    this.#dispose ??= this.#transport.dispose(options).finally(() => this.#cleanupFiles());
    return this.#dispose;
  }
}
