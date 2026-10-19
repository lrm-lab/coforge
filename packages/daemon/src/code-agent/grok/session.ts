import type {
  AgentNoticeOptions,
  AgentRuntimeEvent,
  AgentSession,
  AgentSessionIdentity,
  AgentSessionOptions,
} from "@coforge/agent";
import { agentEnvironment } from "#src/code-agent/environment";
import { withDeadline } from "#src/code-agent/deadline";
import { asRecord, nonEmptyString } from "#src/code-agent/json-record";
import { COFORGE_DAEMON_VERSION } from "#src/version";
import { GrokConnection } from "./connection";
import { GrokTurnEvents } from "./update-events";

const ACP_TIMEOUT_MS = 30_000;
class GrokAcpTimeoutError extends Error {
  constructor() {
    super("Grok ACP operation timed out");
  }
}
const bounded = <T>(work: Promise<T>) =>
  withDeadline(work, ACP_TIMEOUT_MS, () => new GrokAcpTimeoutError());
type Turn = {
  updates: GrokTurnEvents;
  admitted?: ReturnType<typeof Promise.withResolvers<void>>;
  options?: AgentNoticeOptions;
};

export async function createGrokSession(
  options: AgentSessionOptions,
  command: readonly string[],
): Promise<AgentSession> {
  const session = new GrokSession(options, command);
  try {
    await session.open();
    return session;
  } catch (error) {
    await session.dispose();
    throw error;
  }
}

class GrokSession implements AgentSession {
  readonly #transport: GrokConnection;
  readonly #listeners = new Set<(event: AgentRuntimeEvent) => void>();
  readonly #turns = new Map<string, Turn>();
  readonly #completed = new Set<string>();
  readonly #seenEvents = new Set<string>();
  #identity: AgentSessionIdentity | undefined;
  #admissions = Promise.resolve();
  #generation = 0;
  readonly #pendingAdmissions = new Set<ReturnType<typeof Promise.withResolvers<void>>>();
  #disposed = false;
  #failed = false;
  #ready = false;
  #openingQueue: Readonly<Record<string, unknown>> | undefined;
  #runningId: string | undefined;
  #interrupting = false;
  readonly #turnChanged = new Set<() => void>();
  #dispose: Promise<void> | undefined;

  constructor(
    private readonly options: AgentSessionOptions,
    command: readonly string[],
  ) {
    const argv = [
      ...command,
      "--no-auto-update",
      "--no-memory",
      "--trust",
      "agent",
      "--no-leader",
      "--always-approve",
    ];
    if (options.runtime?.model && options.runtime.model !== "default")
      argv.push("--model", options.runtime.model);
    if (options.runtime?.reasoning) argv.push("--reasoning-effort", options.runtime.reasoning);
    argv.push("stdio");
    this.#transport = new GrokConnection(
      argv,
      options.agentWorkspaceDirectory,
      agentEnvironment(options.environment, Bun.env, undefined, {
        envVars: options.runtime?.envVars,
        gitHooks: options.gitHooks,
        extraEnv: { PWD: options.agentWorkspaceDirectory, NO_COLOR: "1" },
      }),
      (method, params) => this.#update(method, params),
    );
    this.#transport.process.onFailure((error) => {
      if (this.#disposed || this.#failed) return;
      this.cancelPendingNotices();
      if (!this.#turns.size)
        this.#emit({ type: "error", message: error.message, providerErrorReason: "process_exit" });
      for (const id of this.#turns.keys())
        this.#finish(id, "error", {
          type: "error",
          message: error.message,
          providerErrorReason: "process_exit",
        });
      this.#failed = true;
    });
  }

  async open() {
    const agent = this.#transport.connection.agent;
    const initialized = await bounded(
      agent.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "coforge-daemon", version: COFORGE_DAEMON_VERSION },
      }),
    );
    if (initialized.protocolVersion !== 1) throw new Error("Unsupported Grok ACP version");
    const methods = initialized.authMethods ?? [];
    const preferred = nonEmptyString(asRecord(initialized._meta)?.defaultAuthMethodId);
    const method =
      methods.find(
        (m) => m.id === preferred && (m.id === "cached_token" || m.id === "xai.api_key"),
      ) ??
      methods.find((m) => m.id === "cached_token") ??
      methods.find((m) => m.id === "xai.api_key");
    if (!method) throw new Error("Grok noninteractive authentication is unavailable");
    await bounded(
      agent.request("authenticate", { methodId: method.id, _meta: { headless: true } }),
    );
    const params = { cwd: this.options.agentWorkspaceDirectory, mcpServers: [] };
    let resuming = !!this.options.sessionId && this.options.sessionMode !== "create";
    let replaced: string | undefined;
    const create = () =>
      bounded(
        agent.request("session/new", {
          ...params,
          _meta: {
            rules: this.options.instructions,
            ...(!replaced && this.options.sessionId ? { sessionId: this.options.sessionId } : {}),
          },
        }),
      );
    const load = async () => {
      try {
        return await bounded(
          agent.request("session/load", { ...params, sessionId: this.options.sessionId! }),
        );
      } catch (error) {
        // Preserve the old adapter's narrow recovery policy: a network/auth failure must
        // never discard resumable history. Only the remote restore's explicit 404 replaces it.
        const data = nonEmptyString(asRecord(error)?.data);
        if (!data || !/Failed to restore session from remote:.*\b404 Not Found\b/u.test(data))
          throw error;
        replaced = this.options.sessionId;
        resuming = false;
        return create();
      }
    };
    const state = resuming ? await load() : await create();
    const sessionId = resuming
      ? this.options.sessionId!
      : "sessionId" in state
        ? state.sessionId
        : undefined;
    if (typeof sessionId !== "string" || !sessionId.trim())
      throw new Error("Grok did not create a session");
    this.#identity = { sessionId, state: resuming ? "resumable" : "empty" };
    const selected = this.options.runtime?.model;
    const modelId =
      selected && selected !== "default"
        ? selected
        : nonEmptyString(asRecord(asRecord(state)?.models)?.currentModelId);
    if ((selected && selected !== "default") || this.options.runtime?.reasoning) {
      if (!modelId) throw new Error("Grok current model is unavailable");
      await bounded(
        agent.request("session/set_model", {
          sessionId,
          modelId,
          ...(this.options.runtime?.reasoning
            ? { _meta: { reasoningEffort: this.options.runtime.reasoning } }
            : {}),
        }),
      );
    }
    await this.options.onSessionId?.(sessionId, replaced);
    this.#ready = true;
    if (this.#openingQueue) this.#update("_x.ai/queue/changed", this.#openingQueue);
    this.#openingQueue = undefined;
  }

  get hasLiveTurn() {
    return !this.#disposed && this.#turns.size > 0;
  }
  async readSessionIdentity() {
    return this.#identity;
  }
  sendMessage(text: string) {
    return this.notify(text);
  }
  notify(text: string, options?: AgentNoticeOptions): Promise<void> {
    const generation = this.#generation;
    const accepted = this.#admissions.then(() => {
      if (generation !== this.#generation || this.#disposed || this.#failed || this.#interrupting)
        throw new Error("Grok notice cancelled");
      return this.hasLiveTurn ? this.#interject(text) : this.#prompt(text, options);
    });
    this.#admissions = accepted.catch(() => {});
    return accepted;
  }

  async #interject(text: string) {
    if (this.#disposed || !this.#identity) throw new Error("Grok cannot accept input");
    const accepted = Promise.withResolvers<void>();
    const pending = this.#waitForAdmission(accepted);
    void this.#transport.connection.agent
      .request<
        { result?: { status?: string }; error?: unknown },
        { sessionId: string; text: string; interjectionId: string }
      >("_x.ai/interject", {
        sessionId: this.#identity.sessionId,
        text,
        interjectionId: crypto.randomUUID(),
      })
      .then(
        (response) => {
          if (this.#disposed || response.error || response.result?.status !== "queued")
            accepted.reject(new Error("Grok rejected interjection"));
          else accepted.resolve();
        },
        () => accepted.reject(new Error("Grok rejected interjection")),
      );
    await pending;
    // The native actor converts an interjection racing turn end into a fallback prompt.
    // It remains accepted: a daemon retry here would deliver the same notice twice.
  }

  async #prompt(text: string, options?: AgentNoticeOptions) {
    if (this.#disposed || !this.#identity) throw new Error("Grok cannot accept input");
    const id = crypto.randomUUID();
    const admitted = Promise.withResolvers<void>();
    this.#turns.set(id, { admitted, options, updates: new GrokTurnEvents() });
    void this.#transport.connection.agent
      .request("session/prompt", {
        sessionId: this.#identity.sessionId,
        prompt: [{ type: "text", text }],
        _meta: { promptId: id },
      })
      .then(
        (response) => this.#finish(id, response.stopReason),
        (error: unknown) => {
          admitted.reject(new Error("Grok rejected input"));
          const native = asRecord(error);
          const message =
            nonEmptyString(native?.data) ??
            (error instanceof Error ? error.message : "Grok request failed");
          this.#finish(id, "error", {
            type: "error",
            message,
            ...(typeof native?.code === "number" ? { providerErrorCode: String(native.code) } : {}),
          });
        },
      );
    await this.#waitForAdmission(admitted);
  }

  async #waitForAdmission(admitted: ReturnType<typeof Promise.withResolvers<void>>) {
    this.#pendingAdmissions.add(admitted);
    try {
      await bounded(admitted.promise);
    } catch (error) {
      // An unanswered admission has an unknown delivery outcome. Close its native request
      // before rejecting, so neither a late acceptance nor queued retries can escape the fence.
      if (error instanceof GrokAcpTimeoutError) await this.dispose();
      throw error;
    } finally {
      this.#pendingAdmissions.delete(admitted);
    }
  }

  cancelPendingNotices() {
    this.#generation++;
    for (const pending of this.#pendingAdmissions)
      pending.reject(new Error("Grok notice cancelled"));
    this.#pendingAdmissions.clear();
  }

  #update(method: string, params: Readonly<Record<string, unknown>>) {
    if (this.#disposed) return;
    if (!this.#ready) {
      if (method === "_x.ai/queue/changed") this.#openingQueue = params;
      return;
    }
    if (params.sessionId !== this.#identity?.sessionId) return;
    if (method === "_x.ai/queue/changed") {
      const running = nonEmptyString(params.runningPromptId);
      for (const entry of Array.isArray(params.entries) ? params.entries : []) {
        const id = nonEmptyString(asRecord(entry)?.id);
        if (id) this.#turns.get(id)?.admitted?.resolve();
      }
      this.#runningId = running;
      if (running && !this.#completed.has(running)) {
        if (!this.#turns.has(running)) this.#turns.set(running, { updates: new GrokTurnEvents() });
        this.#turns.get(running)?.admitted?.resolve();
        this.#emit({ type: "progress", source: "grok_turn_started" });
      }
      return;
    }
    const eventId = nonEmptyString(asRecord(params._meta)?.eventId);
    if (eventId) {
      if (this.#seenEvents.has(eventId)) return;
      this.#seenEvents.add(eventId);
      if (this.#seenEvents.size > 256)
        this.#seenEvents.delete(this.#seenEvents.values().next().value!);
    }
    const update = asRecord(params.update);
    if (update?.sessionUpdate === "turn_completed") {
      const id = nonEmptyString(update.prompt_id);
      if (id) this.#finish(id, update.stop_reason);
    } else if (update) {
      const promptId = nonEmptyString(asRecord(params._meta)?.promptId) ?? this.#runningId;
      const turn = promptId ? this.#turns.get(promptId) : undefined;
      for (const event of turn?.updates.read(update) ?? []) this.#emit(event, turn?.options);
    }
  }

  #finish(id: string, reason: unknown, error?: Extract<AgentRuntimeEvent, { type: "error" }>) {
    const turn = this.#turns.get(id);
    if (!turn || this.#disposed) return;
    turn.admitted?.resolve();
    for (const event of turn.updates.end()) this.#emit(event, turn.options);
    this.#turns.delete(id);
    if (this.#runningId === id) this.#runningId = undefined;
    for (const changed of this.#turnChanged) changed();
    this.#completed.add(id);
    if (this.#completed.size > 256) this.#completed.delete(this.#completed.values().next().value!);
    if (this.#identity && this.#identity.state !== "resumable") {
      this.#identity = { ...this.#identity, state: "resumable" };
      this.#emit({ type: "session", identity: this.#identity });
    }
    if (reason !== "end_turn" && reason !== "cancelled")
      this.#emit(
        error ?? {
          type: "error",
          message: `Grok stopped the turn (${String(reason)})`,
          providerErrorReason: typeof reason === "string" ? reason : "unknown_stop_reason",
        },
      );
    this.#emit({
      type: "completed",
      status:
        reason === "end_turn" ? "completed" : reason === "cancelled" ? "interrupted" : "failed",
    });
  }

  subscribe(listener: (event: AgentRuntimeEvent) => void) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  #emit(event: AgentRuntimeEvent, options?: AgentNoticeOptions) {
    const conversation = options?.conversation ?? this.options.conversation;
    for (const listener of this.#listeners)
      listener(conversation ? { ...event, conversation } : event);
  }
  async interrupt() {
    if (this.#disposed || !this.#identity || !this.hasLiveTurn) return;
    this.#interrupting = true;
    this.cancelPendingNotices();
    const turns = new Set(this.#turns.keys());
    const stopped = Promise.withResolvers<void>();
    const check = () => {
      if (![...turns].some((id) => this.#turns.has(id))) stopped.resolve();
    };
    this.#turnChanged.add(check);
    try {
      await this.#transport.connection.agent.notify("session/cancel", {
        sessionId: this.#identity.sessionId,
      });
      check();
      await bounded(stopped.promise);
    } finally {
      this.#turnChanged.delete(check);
      this.#interrupting = false;
    }
  }
  onExit(listener: () => void) {
    return this.#transport.process.onClose(listener);
  }
  dispose(): Promise<void> {
    if (this.#dispose) return this.#dispose;
    this.#disposed = true;
    this.cancelPendingNotices();
    for (const turn of this.#turns.values())
      turn.admitted?.reject(new Error("Grok session stopped"));
    this.#turns.clear();
    for (const changed of this.#turnChanged) changed();
    this.#dispose = this.#transport.dispose();
    return this.#dispose;
  }
}
