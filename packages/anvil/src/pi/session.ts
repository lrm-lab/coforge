import type {
  AgentRuntimeEvent,
  AgentSession,
  AgentSessionExit,
  AgentSessionIdentity,
  AgentSessionOptions,
} from "@coforge/agent";
import { createSession, SessionEnvironmentError } from "@coforge/agent";
import { piContextHasMedia, piRequestBody } from "@coforge/agent";
import { AGENT_ACTIVITY_DETAIL_KIND } from "@lrm/coforge-sdk/internal";
import {
  AgentEnvironmentError,
  AgentSessionRecoveryError,
  ModelProviderSettingError,
  RuntimeModelNotFoundError,
} from "#src/contract";
import { errorMessage } from "#src/json-record";
import { SessionExit } from "#src/session-exit";
import type { PiSessionHost } from "./host";
import { PiReplyIntents } from "./reply-intents";
import { piSessionEvents } from "./session-events";

/** Adapt one embedded SDK session without exposing the private Session state machine. */
export async function createPiAgentSession(
  nativeOptions: Parameters<typeof createSession>[0],
  onSessionId: AgentSessionOptions["onSessionId"],
  host: PiSessionHost,
): Promise<AgentSession> {
  const created = await createSession(nativeOptions).catch((error: unknown) => {
    throw typedLaunchError(error, nativeOptions.model);
  });
  try {
    await onSessionId?.(created.sessionId, created.replacedSessionId);
  } catch (error) {
    await created.dispose();
    throw error;
  }
  return new AgentSessionImpl(
    created,
    nativeOptions.sessionId !== undefined && !created.replacedSessionId,
    host,
  );
}

/** The SDK's policy codes for a launch the Agent's model settings cannot satisfy. */
const PROVIDER_SETTING_POLICY_CODES: ReadonlySet<string> = new Set([
  "PI_LAUNCH_PROVIDER_MISSING",
  "PI_LAUNCH_PROVIDER_UNCONFIGURED",
]);

/**
 * Turns the SDK's classified launch failure (`PiLaunchError`, identified by its `policyCode`)
 * into the provider-neutral typed launch error for the cases the Agent's settings fix. The SDK
 * error stays the `cause`, so its trace evidence still reaches the launch logs; any other error
 * is returned unchanged.
 */
function typedLaunchError(error: unknown, configuredModel: string | undefined): unknown {
  if (error instanceof SessionEnvironmentError)
    return new AgentEnvironmentError(error.message, { cause: error });
  const policyCode =
    error && typeof error === "object" ? Reflect.get(error, "policyCode") : undefined;
  if (policyCode === "PI_LAUNCH_MODEL_MISSING") {
    const trace = Reflect.get(error as object, "trace");
    const traced = trace && typeof trace === "object" ? Reflect.get(trace, "model") : undefined;
    const model = typeof traced === "string" && traced ? traced : configuredModel;
    return new RuntimeModelNotFoundError(model || "the configured model", { cause: error });
  }
  if (typeof policyCode === "string" && PROVIDER_SETTING_POLICY_CODES.has(policyCode))
    return new ModelProviderSettingError(errorMessage(error), { cause: error });
  return error;
}

type SdkSession = Awaited<ReturnType<typeof createSession>>["session"];
type PromptOptions = Parameters<SdkSession["prompt"]>[1];

class AgentSessionImpl implements AgentSession {
  /** Busy input steers the live stream (`streamingBehavior: "steer"`). */
  readonly steersBusyTurn = true;
  get contextViewRequestLogPath(): string {
    return this.#runtime.contextViewRequestLogPath;
  }
  readonly #runtime: Awaited<ReturnType<typeof createSession>>;
  readonly #listeners = new Set<(event: AgentRuntimeEvent) => void>();
  readonly #exit = new SessionExit();
  readonly #pendingPrompts = new Set<Promise<void>>();
  /** The tracked prompt() that started the live run; agent_settled retires only it —
   * prompts still in preflight keep the turn live and interrupt()/dispose() waiting
   * for work about to start (task #651). */
  #runPrompt: Promise<void> | undefined;
  #interrupting = false;
  #failure: string | undefined;
  /** The current model's context window, read at the stream seam for the compaction log. */
  #windowTokens: number | undefined;
  #disposed = false;
  #disposal: Promise<void> | undefined;
  #identity: AgentSessionIdentity;
  #contextViewMessageIds: string[] = [];
  #contextViewRequestMessageIds: Array<string[] | undefined> = [];
  #resolveContextViewCapture: (() => void) | undefined;
  #contextViewCapture: Promise<void> = Promise.resolve();

  constructor(
    runtime: Awaited<ReturnType<typeof createSession>>,
    resumed: boolean,
    host: PiSessionHost,
  ) {
    this.#runtime = runtime;
    this.#identity = {
      sessionId: runtime.sessionId,
      state: resumed ? "resumable" : "empty",
    };
    // The SDK's turn_start precedes context/auth preparation, and message_start follows
    // the provider's first stream event. Observe the public stream seam between them.
    const stream = runtime.session.agent.streamFunction.bind(runtime.session.agent);
    runtime.session.agent.streamFunction = (model, context, options) => {
      const requestMessageIds = this.#contextViewMessageIds;
      this.#contextViewRequestMessageIds.push(
        requestMessageIds.length ? requestMessageIds : undefined,
      );
      const writes: Promise<void>[] = [];
      if (piContextHasMedia(context))
        writes.push(
          runtime.contextViewRequestLog.append({
            type: "media",
            sessionId: runtime.sessionId,
            ...(requestMessageIds[0] ? { messageId: requestMessageIds[0] } : {}),
            ...(requestMessageIds.length ? { messageIds: requestMessageIds } : {}),
            timestamp: new Date().toISOString(),
          }),
        );
      writes.push(
        runtime.contextViewRequestLog.append({
          type: "request",
          sessionId: runtime.sessionId,
          ...(requestMessageIds[0] ? { messageId: requestMessageIds[0] } : {}),
          ...(requestMessageIds.length ? { messageIds: requestMessageIds } : {}),
          body: piRequestBody(context, model),
          timestamp: new Date().toISOString(),
        }),
      );
      void Promise.all(writes).then(() => this.#resolveContextViewCapture?.());
      // The window every request runs in, for the compaction log: Pi's own model entry knows it,
      // and the compaction result itself does not carry one.
      this.#windowTokens = model.contextWindow;
      // Summaries use this stream too; keep their more specific compaction phase.
      if (!runtime.session.isCompacting && !this.#disposed && !this.#interrupting) {
        try {
          this.#emit({
            type: "activity",
            activity: {
              detailKind: AGENT_ACTIVITY_DETAIL_KIND.MODEL_REQUEST_STARTED,
              level: "info",
              detail: "Waiting for model response",
              observedAtMs: Date.now(),
            },
          });
        } catch {
          // Best-effort observation must never prevent the provider request.
        }
      }
      return stream(model, context, options);
    };
    const replyIntents = new PiReplyIntents(host);
    runtime.session.subscribe((event) => {
      if (event.type === "agent_start" && (this.#disposed || this.#interrupting)) {
        // A host preflight hook may finish after cancellation began. The SDK
        // only makes that prompt abortable once its run starts.
        void this.#trackPrompt(runtime.session.abort());
      }
      for (const translated of piSessionEvents(event, this.#windowTokens)) this.#emit(translated);
      for (const replyIntent of replyIntents.read(event)) this.#emit(replyIntent);
      // A failed attempt may be retried, and cancellation may surface as an error.
      // Only settlement determines the run's terminal result.
      if (event.type === "message_end" && event.message.role === "assistant") {
        const responseMessageIds = this.#contextViewRequestMessageIds.shift();
        void runtime.contextViewRequestLog.append({
          type: "response",
          sessionId: runtime.sessionId,
          ...(responseMessageIds?.[0] ? { messageId: responseMessageIds[0] } : {}),
          ...(responseMessageIds?.length ? { messageIds: responseMessageIds } : {}),
          body: event.message,
          timestamp: new Date().toISOString(),
        });
        this.#failure =
          event.message.stopReason === "error"
            ? (event.message.errorMessage ?? "Agent failed")
            : undefined;
      }
      if (event.type === "agent_settled") {
        this.#resolveContextViewCapture?.();
        this.#resolveContextViewCapture = undefined;
        this.#contextViewMessageIds = [];
        this.#contextViewRequestMessageIds = [];
        // The SDK resolves the settled run's prompt() promise only after _startRun returns,
        // a microtask after this event — so its bookkeeping must end here, before "completed"
        // reaches listeners that read hasLiveTurn (the invariant Kiro documents on #turn).
        // Only that run's prompt is retired: a prompt still inside preflight has no run yet
        // and must keep the turn live (task #651).
        const settled = this.#runPrompt;
        this.#runPrompt = undefined;
        if (settled !== undefined) this.#pendingPrompts.delete(settled);
        const interrupted = event.aborted || this.#interrupting;
        const failure = this.#failure;
        if (failure !== undefined && !interrupted) this.#emit({ type: "error", message: failure });
        this.#emit({
          type: "completed",
          status: interrupted ? "interrupted" : failure !== undefined ? "failed" : "completed",
        });
        this.#failure = undefined;
      }
    });
  }
  setContextViewMessageId(messageId: string | undefined): void {
    this.#contextViewMessageIds = messageId ? [messageId] : [];
  }
  setContextViewMessageIds(messageIds: readonly string[]): void {
    this.#contextViewMessageIds = [...messageIds];
    this.#contextViewCapture = new Promise((resolve) => {
      this.#resolveContextViewCapture = resolve;
    });
  }
  async waitForContextViewCapture(): Promise<void> {
    await Promise.race([
      this.#contextViewCapture,
      new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
    ]);
  }
  async sendMessage(message: string) {
    if (this.#disposed || this.#interrupting || this.#runtime.session.isStreaming) {
      throw new Error("code agent cannot accept a new message");
    }
    this.#runtime.resetMemoryBudget?.();
    this.#setIdentity("unknown");
    const tracked = this.#prompt(message);
    try {
      await tracked;
    } catch (error) {
      // A rejected admission settles its bookkeeping before "completed", same as agent_settled.
      this.#pendingPrompts.delete(tracked);
      if (this.#runPrompt === tracked) this.#runPrompt = undefined;
      this.#emit({
        type: "error",
        message: error instanceof Error ? error.message : "Agent failed",
      });
      this.#emit({ type: "completed", status: "failed" });
      if (/Cannot continue from message role:\s*assistant/i.test(errorMessage(error)))
        throw new AgentSessionRecoveryError("provider_replay_rejected");
      throw error;
    }
  }

  get hasLiveTurn(): boolean {
    return !this.#disposed && (this.#runtime.session.isStreaming || this.#pendingPrompts.size > 0);
  }
  async notify(notice: string) {
    if (this.#disposed || this.#interrupting) {
      throw new Error("code agent cannot accept a notification");
    }
    // Every notice is a new triggering message (inbox delivery, held-notice
    // redelivery, app item); the memory budget is scoped per triggering
    // message, so it must reset here too — not only on sendMessage.
    this.#runtime.resetMemoryBudget?.();
    // SDK prompt completion waits for the whole run; preflight is the public
    // acceptance boundary used by Pi's RPC implementation as well.
    await new Promise<void>((resolve, reject) => {
      void this.#prompt(notice, {
        streamingBehavior: "steer",
        // Any disposition (`started`, `queued`, `handled`) means the SDK accepted the input; a
        // rejected prompt settles through the returned promise instead.
        preflightResult: () => resolve(),
      }).catch(reject);
    });
  }
  subscribe(listener: (event: AgentRuntimeEvent) => void) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  async readSessionIdentity(): Promise<AgentSessionIdentity> {
    if (
      !this.#disposed &&
      this.#runtime.session.sessionFile &&
      (await Bun.file(this.#runtime.session.sessionFile).exists())
    )
      this.#setIdentity("resumable");
    return this.#identity;
  }
  async interrupt() {
    this.#interrupting = true;
    this.#runtime.session.clearQueue();
    try {
      await this.#runtime.session.abort();
      await Promise.allSettled(this.#pendingPrompts);
    } finally {
      this.#interrupting = false;
    }
  }
  onExit(listener: (exit?: AgentSessionExit) => void) {
    return this.#exit.onExit(listener);
  }
  dispose(_options?: Readonly<{ cutoffAtMs?: number }>) {
    if (this.#disposal) return this.#disposal;
    this.#disposed = true;
    this.#runtime.session.clearQueue();
    this.#disposal = (async () => {
      await this.#runtime.session.abort();
      await Promise.allSettled(this.#pendingPrompts);
      await this.#runtime.dispose();
      this.#exit.finish();
    })();
    return this.#disposal;
  }
  /** session.prompt() with run ownership tracked: `preflightResult("started")` names the
   * one prompt that owns the run agent_settled will retire. */
  #prompt(text: string, options?: PromptOptions): Promise<void> {
    const prompt = this.#runtime.session.prompt(text, {
      ...options,
      preflightResult: (disposition) => {
        options?.preflightResult?.(disposition);
        if (disposition === "started") this.#runPrompt = prompt;
      },
    });
    return this.#trackPrompt(prompt);
  }
  #trackPrompt(promise: Promise<void>) {
    this.#pendingPrompts.add(promise);
    void promise.then(
      () => this.#pendingPrompts.delete(promise),
      () => this.#pendingPrompts.delete(promise),
    );
    return promise;
  }
  #emit(event: AgentRuntimeEvent) {
    for (const listener of this.#listeners) listener(event);
  }
  #setIdentity(state: AgentSessionIdentity["state"]) {
    if (this.#identity.state === state) return;
    this.#identity = { sessionId: this.#identity.sessionId, state };
    this.#emit({ type: "session", identity: this.#identity });
  }
}
