import {
  RequestError,
  type RequestPermissionRequest,
  type SessionConfigOption,
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
import { DevinConnection, DEVIN_ACP_TIMEOUT_MS, devinBounded } from "./connection";
import { DevinTurnEvents } from "./update-events";
import type { DevinProviderOptions } from "./host";
import { createDevinRuleFile, type DevinRuleFile } from "./rules";

/** Full access, matching every other runtime: no approval prompts for edits or commands. */
export const DEVIN_PERMISSION_MODE = "bypass";

type Input = {
  text: string;
  options?: AgentNoticeOptions;
  admission: ReturnType<typeof Promise.withResolvers<void>>;
  attempted: boolean;
  updates: DevinTurnEvents;
};

/** One native prompt at a time; local queue custody is never native acceptance. */
export class DevinSession implements AgentSession {
  #transport: DevinConnection | undefined;
  #rule: DevinRuleFile | undefined;
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
    private readonly providerOptions: DevinProviderOptions,
  ) {
    this.#timeoutMs = providerOptions.acpTimeoutMs ?? DEVIN_ACP_TIMEOUT_MS;
  }

  async open() {
    // Devin only reads an always-on rule at session start, so it must exist before session/new.
    this.#rule = await createDevinRuleFile(
      this.options.agentWorkspaceDirectory,
      this.options.instructions,
    );
    try {
      const transport = new DevinConnection(
        this.command,
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
      const cwd = this.options.agentWorkspaceDirectory;
      const resuming =
        this.options.sessionId !== undefined && this.options.sessionMode !== "create";
      let replacedSessionId: string | undefined;
      let sessionId: string | undefined;
      let configOptions: SessionConfigOption[] = [];
      if (resuming) {
        try {
          const loaded = await this.#bounded(
            agent.request("session/load", {
              sessionId: this.options.sessionId!,
              cwd,
              mcpServers: [],
            }),
          );
          sessionId = this.options.sessionId;
          configOptions = loaded.configOptions ?? [];
        } catch (error) {
          if (!sessionGone(error)) throw error;
          replacedSessionId = this.options.sessionId;
        }
      }
      if (!sessionId) {
        const created = await this.#bounded(agent.request("session/new", { cwd, mcpServers: [] }));
        sessionId = created.sessionId;
        configOptions = created.configOptions ?? [];
      }
      if (!sessionId.trim()) throw new Error("Devin did not create a session");
      this.#identity = {
        sessionId,
        state: resuming && !replacedSessionId ? "resumable" : "empty",
      };
      // A session that cannot enter the full-access mode must not run under a prompting one.
      await this.#bounded(
        agent.request("session/set_mode", {
          sessionId,
          modeId: DEVIN_PERMISSION_MODE,
        }),
      );
      await this.#applyRuntimeConfig(sessionId, configOptions);
      await this.options.onSessionId?.(sessionId, replacedSessionId);
    } catch (error) {
      await this.dispose().catch(() => undefined);
      throw error;
    }
  }

  async #applyRuntimeConfig(sessionId: string, initial: SessionConfigOption[]) {
    const model = this.options.runtime?.model;
    const reasoning = this.options.runtime?.reasoning;
    if (!model && !reasoning) return;
    const transport = this.#requireTransport();
    let config = initial;
    const select = async (category: string, value: string) => {
      const option = config.find((entry) => entry.category === category);
      const id = option?.id ?? category;
      const available =
        option?.type === "select" &&
        option.options.some((entry) =>
          "value" in entry
            ? entry.value === value
            : entry.options.some((child) => child.value === value),
        );
      if (!available) {
        if (category === "model") throw new RuntimeModelNotFoundError(value);
        throw new Error(`Devin ${category} selection is unavailable`);
      }
      const configured = await this.#bounded(
        transport.connection.agent.request("session/set_config_option", {
          sessionId,
          configId: id,
          value,
        }),
      );
      config = configured.configOptions;
      if (!config.some((entry) => entry.id === id && entry.currentValue === value))
        throw new Error(`Devin did not apply ${id}`);
    };
    if (model) {
      config = await transport.waitForConfig(sessionId, config, "model", this.#timeoutMs);
      await select("model", model);
    }
    // Effort options depend on the model that was just selected. When the returned option does
    // not exist, the model's own default stays. A present option that lacks the value fails.
    if (!reasoning) return;
    if (config.some((entry) => entry.category === "thought_level"))
      await select("thought_level", reasoning);
  }
  #requireTransport() {
    const transport = this.#transport;
    if (!transport) throw new Error("Devin session is not open");
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
      return Promise.reject(new Error("Devin cannot accept input before submission"));
    const admission = Promise.withResolvers<void>();
    this.#queue.push({
      text,
      options,
      admission,
      attempted: false,
      updates: new DevinTurnEvents(this.providerOptions.host),
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
        input.admission.reject(new Error("Devin input cancelled; delivery outcome is unknown"));
        status = "interrupted";
      } else {
        this.#accept(input);
        this.#emit(
          { type: "error", message: `Devin prompt stopped: ${response.stopReason}` },
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
              ? "Devin input delivery outcome is unknown"
              : "Devin rejected input before submission",
          ),
        );
      // A terminal RPC failure is an accepted failed turn. Only transport loss leaves delivery
      // unknown; neither outcome permits automatic resending or notice-undelivered.
      const data = rpcFailure ? asRecord(error.data) : undefined;
      const detail =
        nonEmptyString(data?.detail) ??
        nonEmptyString(data?.message) ??
        (rpcFailure ? nonEmptyString(error.data) : undefined) ??
        (error instanceof Error ? error.message : "Devin prompt failed");
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
      input.admission.reject(new Error("Devin queued input cancelled before submission"));
    this.#active?.admission.reject(
      new Error(
        this.#active.attempted
          ? "Devin input cancelled; delivery outcome is unknown"
          : "Devin input cancelled before submission",
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
      this.#emit({ type: "error", message: "Devin process cleanup failed" });
    }));
  }
  #exitedNow() {
    this.#exited = true;
    for (const listener of this.#exitListeners) listener();
    this.#exitListeners.clear();
  }
  #bounded<T>(work: Promise<T>) {
    return devinBounded(work, this.#timeoutMs);
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
      await this.#rule?.remove();
    }
  }
}

/** A requested session Devin no longer has is replaced, the Codex recovery rule. Devin marks it
 * structurally (`-32016`, `data["cognition.ai/errorKind"]: "session_not_found"`, observed on CLI
 * 3000.11.228); any other failure (auth, protocol, transport) surfaces instead of silently
 * starting a new session. */
function sessionGone(error: unknown): boolean {
  return (
    error instanceof RequestError &&
    asRecord(error.data)?.["cognition.ai/errorKind"] === "session_not_found"
  );
}
