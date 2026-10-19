import { RequestError, type RequestPermissionRequest } from "@agentclientprotocol/sdk";
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

export const ACP_TIMEOUT_MS = 30_000;
class GrokAcpTimeoutError extends Error {
  constructor() {
    super("Grok ACP operation timed out");
  }
}
const bounded = <T>(work: Promise<T>) =>
  withDeadline(work, ACP_TIMEOUT_MS, () => new GrokAcpTimeoutError());
// Stop reasons that end a turn normally; `cancelled` is an interruption and any other one failed.
const COMPLETED_STOP_REASONS = new Set<unknown>([
  "end_turn",
  "max_tokens",
  "max_turn_requests",
  "refusal",
]);
const SEEN_LIMIT = 256;
/** Adds `value`, evicting the oldest entry once the set exceeds its bound. */
function remember(seen: Set<string>, value: string) {
  seen.add(value);
  if (seen.size > SEEN_LIMIT) seen.delete(seen.values().next().value!);
}
/** The prompt a native `turn_completed` update ends, when the update is one. */
function completedPromptId(update: Readonly<Record<string, unknown>> | undefined) {
  return update?.sessionUpdate === "turn_completed" ? nonEmptyString(update.prompt_id) : undefined;
}
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
  readonly #pendingAdmissions = new Set<{ reject: (reason: unknown) => void }>();
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
      (request) => this.#permission(request),
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
    const canLoad = initialized.agentCapabilities?.loadSession === true;
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
            yoloMode: true,
            ...(!replaced && this.options.sessionId ? { sessionId: this.options.sessionId } : {}),
          },
        }),
      );
    const load = async () => {
      if (!canLoad) throw new Error("Grok cannot resume sessions: ACP loadSession is unavailable");
      try {
        return await bounded(
          agent.request("session/load", {
            ...params,
            sessionId: this.options.sessionId!,
            _meta: { yoloMode: true },
          }),
        );
      } catch (error) {
        // Only a missing session is replaced. Grok reports a local miss whose remote pull 404s,
        // fails or is not configured as -32603 with data.code FS_NOT_FOUND. Other I/O failures
        // carry another data.code; any failure but that one keeps the identity and fails launch.
        const native = asRecord(error);
        if (native?.code !== -32603 || asRecord(native.data)?.code !== "FS_NOT_FOUND") throw error;
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
      if (this.#noticeCancelled(generation)) throw new Error("Grok notice cancelled");
      return this.hasLiveTurn
        ? this.#interject(text, options, generation)
        : this.#prompt(text, options);
    });
    this.#admissions = accepted.catch(() => {});
    return accepted;
  }

  #noticeCancelled(generation: number) {
    return generation !== this.#generation || this.#disposed || this.#failed || this.#interrupting;
  }

  async #interject(text: string, options: AgentNoticeOptions | undefined, generation: number) {
    if (this.#disposed || !this.#identity) throw new Error("Grok cannot accept input");
    const queued = Promise.withResolvers<boolean>();
    const pending = this.#waitForAdmission(queued);
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
          if (this.#disposed) queued.reject(new Error("Grok rejected interjection"));
          else queued.resolve(!response.error && response.result?.status === "queued");
        },
        // Grok answers `queued` whenever it holds the session; its only refusal is a JSON-RPC
        // error (extensions/interject.rs: invalid_params for an unknown session or malformed
        // params). A closed transport is no answer: the notice may be queued, so never resend it.
        (error: unknown) => {
          if (error instanceof RequestError && !this.#disposed) queued.resolve(false);
          else queued.reject(new Error("Grok rejected interjection"));
        },
      );
    // A queued interjection racing turn end becomes Grok's own fallback prompt, so it stays
    // accepted: a daemon retry would deliver the same notice twice. Only a refusal is resent.
    if (await pending) return;
    if (this.#noticeCancelled(generation)) throw new Error("Grok notice cancelled");
    await this.#prompt(text, options);
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
          // Grok's JSON-RPC error data is `{detail, code}`; older shapes carry a string.
          const message =
            nonEmptyString(asRecord(native?.data)?.detail) ??
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

  async #waitForAdmission<T>(admitted: ReturnType<typeof Promise.withResolvers<T>>) {
    this.#pendingAdmissions.add(admitted);
    try {
      return await bounded(admitted.promise);
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

  /** Grok asks only when always-approve is off; a request outside the live session is cancelled,
   * as ACP requires for every pending request once its turn is being cancelled. */
  #permission(request: RequestPermissionRequest) {
    const allow =
      !this.#disposed && !this.#interrupting && request.sessionId === this.#identity?.sessionId
        ? (request.options.find((option) => option.kind === "allow_once") ??
          request.options.find((option) => option.kind === "allow_always"))
        : undefined;
    return {
      outcome: allow
        ? { outcome: "selected" as const, optionId: allow.optionId }
        : { outcome: "cancelled" as const },
    };
  }

  #update(method: string, params: Readonly<Record<string, unknown>>) {
    if (this.#disposed) return;
    if (!this.#ready) {
      if (method === "_x.ai/queue/changed") this.#openingQueue = params;
      // A turn that finished before the session was reported must not be revived by the
      // queue snapshot replayed once it is ready. Only Grok's own notification carries it, so
      // replayed `session/update` history is skipped.
      const finished =
        method === "_x.ai/session_notification"
          ? completedPromptId(asRecord(params.update))
          : undefined;
      if (finished) remember(this.#completed, finished);
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
      remember(this.#seenEvents, eventId);
    }
    const update = asRecord(params.update);
    const finished = completedPromptId(update);
    if (finished) this.#finish(finished, update?.stop_reason);
    else if (update && update.sessionUpdate !== "turn_completed") {
      const promptId = nonEmptyString(asRecord(params._meta)?.promptId) ?? this.#runningId;
      const turn = promptId ? this.#turns.get(promptId) : undefined;
      // Grok streams only a prompt it is already running, so its own update also admits it.
      turn?.admitted?.resolve();
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
    remember(this.#completed, id);
    if (this.#identity && this.#identity.state !== "resumable") {
      this.#identity = { ...this.#identity, state: "resumable" };
      this.#emit({ type: "session", identity: this.#identity });
    }
    const status = COMPLETED_STOP_REASONS.has(reason)
      ? "completed"
      : reason === "cancelled"
        ? "interrupted"
        : "failed";
    if (status === "failed")
      this.#emit(
        error ?? {
          type: "error",
          message: `Grok stopped the turn (${String(reason)})`,
          providerErrorReason: typeof reason === "string" ? reason : "unknown_stop_reason",
        },
      );
    this.#emit({ type: "completed", status });
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
