import { RequestError, type RequestPermissionRequest } from "@agentclientprotocol/sdk";
import { dirname, join } from "node:path";
import type {
  AgentNoticeOptions,
  AgentRuntimeEvent,
  AgentSession,
  AgentSessionIdentity,
  AgentSessionOptions,
} from "@coforge/agent";
import { asRecord, nonEmptyString } from "#src/json-record";
import { scrubRuntimeErrorText } from "#src/runtime-error-text";
import {
  CommandCodeConnection,
  COMMAND_CODE_ACP_TIMEOUT_MS,
  commandCodeBounded,
} from "./connection";
import { CommandCodeTurnEvents } from "./update-events";
import type { CommandCodeProviderOptions } from "./host";
import {
  COMMAND_CODE_INSTRUCTION_MOD_LOADED,
  createCommandCodeInstructionMod,
  type CommandCodeInstructionMod,
} from "./instructions-mod";
import { COMMAND_CODE_MIN_CLI_VERSION } from "./version";

type Input = {
  text: string;
  options?: AgentNoticeOptions;
  admission: ReturnType<typeof Promise.withResolvers<void>>;
  attempted: boolean;
  updates: CommandCodeTurnEvents;
};

/** One native prompt at a time; local queue custody is never native acceptance. */
export class CommandCodeSession implements AgentSession {
  #transport: CommandCodeConnection | undefined;
  #mod: CommandCodeInstructionMod | undefined;
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

  constructor(
    private readonly command: readonly string[],
    private readonly options: AgentSessionOptions,
    private readonly providerOptions: CommandCodeProviderOptions,
  ) {
    this.#timeoutMs = providerOptions.acpTimeoutMs ?? COMMAND_CODE_ACP_TIMEOUT_MS;
  }

  async open() {
    this.#mod = await createCommandCodeInstructionMod(this.options.instructions);
    try {
      const transport = new CommandCodeConnection(
        this.command,
        this.#mod.modPath,
        this.options.agentWorkspaceDirectory,
        this.providerOptions.host.buildEnvironment(this.options),
        this.providerOptions.host,
        (sessionId, update) => this.#update(sessionId, update),
        (request) => this.#permission(request),
        () => {
          if (this.#active) this.#active.attempted = true;
        },
      );
      this.#transport = transport;
      transport.process.onClose(() => {
        this.#failed = true;
        void this.#terminate().then(() => this.#exitedNow());
      });
      const agent = transport.connection.agent;
      await transport.initialize(this.#timeoutMs);
      const loaded = join(dirname(this.#mod.modPath), COMMAND_CODE_INSTRUCTION_MOD_LOADED);
      if (!(await Bun.file(loaded).exists()))
        throw new Error(
          `Command Code did not load the instruction mod. A CLI older than ${COMMAND_CODE_MIN_CLI_VERSION} ignores --mod on cmd acp, and a mods.disableAll setting skips --mod, so the standing instructions would be missing.`,
        );
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
        throw new Error("COMMAND_CODE did not create a session");
      this.#identity = { sessionId, state: resuming ? "resumable" : "empty" };
      // Command Code ACP does not expose a model list reliably; keep its native default.
      await this.options.onSessionId?.(sessionId);
    } catch (error) {
      await this.dispose().catch(() => undefined);
      throw error;
    }
  }

  #requireTransport() {
    const transport = this.#transport;
    if (!transport) throw new Error("COMMAND_CODE session is not open");
    return transport;
  }

  get hasLiveTurn() {
    return !this.#disposed && (!!this.#active || this.#queue.length > 0);
  }
  sendMessage(text: string) {
    return this.notify(text);
  }
  notify(text: string, options?: AgentNoticeOptions): Promise<void> {
    if (this.#disposed || this.#failed || this.#interrupting)
      return Promise.reject(new Error("COMMAND_CODE cannot accept input before submission"));
    const admission = Promise.withResolvers<void>();
    this.#queue.push({
      text,
      options,
      admission,
      attempted: false,
      updates: new CommandCodeTurnEvents(this.providerOptions.host),
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
          new Error("COMMAND_CODE input cancelled; delivery outcome is unknown"),
        );
        status = "interrupted";
      } else {
        this.#accept(input);
        this.#emit(
          { type: "error", message: `COMMAND_CODE prompt stopped: ${response.stopReason}` },
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
              ? "COMMAND_CODE input delivery outcome is unknown"
              : "COMMAND_CODE rejected input before submission",
          ),
        );
      // A terminal RPC failure is an accepted failed turn. Only transport loss leaves delivery
      // unknown; neither outcome permits automatic resending or notice-undelivered.
      const data = rpcFailure ? asRecord(error.data) : undefined;
      const detail =
        nonEmptyString(data?.detail) ??
        nonEmptyString(data?.message) ??
        (rpcFailure ? nonEmptyString(error.data) : undefined) ??
        (error instanceof Error ? error.message : "COMMAND_CODE prompt failed");
      if (!this.#disposed)
        this.#emit(
          {
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
      input.admission.reject(new Error("COMMAND_CODE queued input cancelled before submission"));
    this.#active?.admission.reject(
      new Error(
        this.#active.attempted
          ? "COMMAND_CODE input cancelled; delivery outcome is unknown"
          : "COMMAND_CODE input cancelled before submission",
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
        if (this.#turn) await this.#bounded(this.#turn);
      }
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
      this.#emit({ type: "error", message: "Command Code process cleanup failed" });
    }));
  }
  #exitedNow() {
    this.#exited = true;
    for (const listener of this.#exitListeners) listener();
    this.#exitListeners.clear();
  }
  #bounded<T>(work: Promise<T>) {
    return commandCodeBounded(work, this.#timeoutMs);
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
      await this.#mod?.remove();
    }
  }
}
