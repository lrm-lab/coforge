import type {
  AgentRuntimeEvent,
  AgentSession,
  AgentSessionIdentity,
  AgentSessionOptions,
  UsageSnapshot,
} from "@coforge/agent";
import type { CodeAgentProvider } from "@lrm/coforge-anvil";
import { CodexItemEvents } from "./item-events";
import { rejectServerRequests } from "./server-requests";
import { openCodexThread } from "./thread-open";
import { codexTurnOutcome } from "./turn-outcome";
import { CodexTurnSignals } from "./turn-signals";
import { readCodexUsage } from "./usage";
import { agentEnvironment } from "#src/code-agent/environment";
import { JsonlProcess, JsonlRequestError } from "#src/code-agent/jsonl-process";
import { COFORGE_DAEMON_VERSION } from "#src/version";
import {
  RUNTIME_PROVIDER,
  utf8Encoder,
  type AgentServiceTierObserved,
} from "@lrm/coforge-sdk/internal";
import { getLogger } from "@logtape/logtape";
import { asRecord, eventTime } from "#src/code-agent/json-record";
import {
  assertSkillsLoaded,
  codexServiceTierState,
  scrubError,
  type CodexSessionState,
} from "./provider-support";

const logger = getLogger(["coforge", "daemon", "code-agent", "codex"]);

export class CodexProvider implements CodeAgentProvider {
  readonly provider = RUNTIME_PROVIDER.CODEX;
  readonly #command: readonly string[];

  constructor(options: { command?: readonly string[] } = {}) {
    this.#command = options.command ?? ["codex", "app-server"];
  }

  async readUsage(options: {
    workingDirectory: string;
    timeoutMs?: number;
  }): Promise<UsageSnapshot | null> {
    return readCodexUsage(options.workingDirectory, {
      command: this.#command,
      timeoutMs: options.timeoutMs,
    });
  }

  async createAgentSession(options: AgentSessionOptions): Promise<AgentSession> {
    if (options.sessionId !== undefined && !options.sessionId.trim())
      throw new Error("Invalid session ID");
    const process = new JsonlProcess(
      this.#command,
      options.agentWorkspaceDirectory,
      agentEnvironment(options.environment, Bun.env, undefined, {
        envVars: options.runtime?.envVars,
        extraEnv: { NO_COLOR: "1" },
        gitHooks: options.gitHooks,
      }),
    );
    rejectServerRequests(process, options.agentId, options.runtimeId);
    try {
      await process.request({
        method: "initialize",
        params: {
          clientInfo: {
            name: "coforge_daemon",
            title: "CoForge Daemon",
            version: COFORGE_DAEMON_VERSION,
          },
          capabilities: { experimentalApi: false },
        },
      });
      await process.send({ method: "initialized", params: {} });
      const skillsResponse = await process.request({
        method: "skills/list",
        params: { cwds: [options.agentWorkspaceDirectory], forceReload: true },
      });
      assertSkillsLoaded(skillsResponse, options.agentWorkspaceDirectory);
      const { threadId, result, replacedSessionId } = await openCodexThread(process, options);
      await options.onSessionId?.(threadId, replacedSessionId);
      logger.info("Codex thread received standing instructions", {
        event: "codex.instructions.injected",
        agent_id: options.agentId,
        runtime_id: options.runtimeId,
        instruction_bytes: utf8Encoder.encode(options.instructions).byteLength,
        outcome: "ok",
      });
      return new CodexAgentSession(
        process,
        threadId,
        options.sessionId !== undefined && replacedSessionId === undefined,
        options.agentId,
        options.runtimeId,
        // Only a launch that asked for the Fast tier has anything to report about it.
        options.runtime?.fastMode ? codexServiceTierState(result?.serviceTier) : undefined,
      );
    } catch (error) {
      await process.dispose();
      throw error;
    }
  }
}

class CodexAgentSession implements AgentSession {
  readonly #process: JsonlProcess;
  readonly #threadId: string;
  readonly #agentId: string | undefined;
  readonly #runtimeId: string | undefined;
  readonly #listeners = new Set<(event: AgentRuntimeEvent) => void>();
  readonly #commandOutputBytes = new Map<string, number>();
  readonly #itemEvents = new CodexItemEvents();
  readonly #signals: CodexTurnSignals;
  #state: CodexSessionState = { type: "idle" };
  #lastCompletedTurnId: string | undefined;
  #starting: Promise<void> | undefined;
  #identity: AgentSessionIdentity;
  /** The service tier codex applied at thread/start, from its own reply. Reported on the first
   * turn rather than in the constructor: the daemon subscribes only after
   * `createAgentSession` returns, so an event emitted here would be dropped. */
  readonly #serviceTier: AgentServiceTierObserved | undefined;
  #serviceTierReported = false;

  constructor(
    process: JsonlProcess,
    threadId: string,
    resumed: boolean,
    agentId?: string,
    runtimeId?: string,
    serviceTier?: AgentServiceTierObserved,
  ) {
    this.#process = process;
    this.#threadId = threadId;
    this.#agentId = agentId;
    this.#runtimeId = runtimeId;
    this.#signals = new CodexTurnSignals(threadId, agentId, runtimeId);
    this.#serviceTier = serviceTier;
    this.#identity = {
      sessionId: threadId,
      state: resumed ? "resumable" : "empty",
    };
    process.onRecord((record) => this.#accept(record));
    process.onStderr((text) => {
      const match = /Reconnecting\.\.\.\s*(\d+)\s*\/\s*\d+/i.exec(text);
      if (!match) return;
      // Raw stderr line as the fact; the daemon core formats/redacts it into the
      // visible `runtime_reconnecting` Activity (agent-runtime/runtime-error-activity.ts).
      this.#emit({ type: "reconnecting", attempt: Number(match[1]), message: text });
    });
    // Whether an unexpected close reads as a crash is the daemon core's call, made
    // from this fact at the moment the process actually exits.
    process.onFailure((error) => this.#emit({ type: "error", message: error.message }));
  }

  async sendMessage(text: string): Promise<void> {
    if (this.#state.type !== "idle") throw new Error("code agent is already running");
    const starting = this.#startTurn(text);
    this.#starting = starting;
    try {
      await starting;
    } finally {
      if (this.#starting === starting) this.#starting = undefined;
    }
  }

  get hasLiveTurn(): boolean {
    return (
      this.#state.type === "running" ||
      this.#state.type === "interrupting" ||
      (this.#state.type === "starting" && this.#state.completedTurnIds.size === 0)
    );
  }

  async #startTurn(text: string): Promise<void> {
    if (!this.#serviceTierReported) {
      this.#serviceTierReported = true;
      if (this.#serviceTier) this.#emit({ type: "service-tier", state: this.#serviceTier });
    }
    this.#setIdentity("unknown");
    this.#state = { type: "starting", completedTurnIds: new Set() };
    let response: Readonly<Record<string, unknown>>;
    try {
      response = await this.#process.request({
        method: "turn/start",
        params: {
          threadId: this.#threadId,
          input: [{ type: "text", text }],
        },
      });
    } catch (error) {
      if (!this.#isDisposed()) this.#state = { type: "idle" };
      throw error;
    }
    const turn = asRecord(asRecord(response.result)?.turn);
    if (typeof turn?.id !== "string") {
      if (!this.#isDisposed()) this.#state = { type: "idle" };
      throw new Error("Codex did not create a turn");
    }
    this.#setIdentity("resumable");
    if (this.#state.type !== "starting") return;
    this.#state = this.#state.completedTurnIds.has(turn.id)
      ? { type: "idle" }
      : { type: "running", turnId: turn.id };
  }

  async notify(notice: string): Promise<void> {
    await this.#acceptNotice(notice);
    logger.info("Codex accepted inbox wakeup", {
      event: "codex.wakeup.accepted",
      agent_id: this.#agentId,
      runtime_id: this.#runtimeId,
      notice_bytes: utf8Encoder.encode(notice).byteLength,
      outcome: "ok",
    });
  }

  async #acceptNotice(notice: string): Promise<void> {
    // Only retry a rejected admission when the active turn ended. Other RPC
    // failures remain failures so the daemon retains the unacknowledged attention.
    for (let attempt = 0; attempt < 2; attempt++) {
      if (this.#starting) await this.#starting;
      const state = this.#state;
      if (state.type === "idle") return this.sendMessage(notice);
      if (state.type !== "running") throw new Error("code agent cannot accept a notification");
      try {
        const response = await this.#process.request({
          method: "turn/steer",
          params: {
            threadId: this.#threadId,
            expectedTurnId: state.turnId,
            input: [{ type: "text", text: notice }],
          },
        });
        if (asRecord(response.result)?.turnId !== state.turnId) {
          throw new Error("Codex did not accept the notification for the active turn");
        }
        return;
      } catch (error) {
        const rpcError =
          error instanceof JsonlRequestError ? asRecord(error.responseError) : undefined;
        if (
          attempt > 0 ||
          rpcError?.code !== -32600 ||
          rpcError.message !== "no active turn to steer"
        ) {
          throw error;
        }
        if (this.#state === state) this.#state = { type: "idle" };
      }
    }
  }

  subscribe(listener: (event: AgentRuntimeEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async readSessionIdentity(): Promise<AgentSessionIdentity> {
    return this.#identity;
  }

  async interrupt(): Promise<void> {
    if (this.#state.type !== "running") return;
    const turnId = this.#state.turnId;
    this.#state = { type: "interrupting", turnId };
    try {
      await this.#process.request({
        method: "turn/interrupt",
        params: { threadId: this.#threadId, turnId },
      });
    } catch (error) {
      if (!this.#isDisposed()) this.#state = { type: "running", turnId };
      throw error;
    }
  }

  onExit(listener: () => void): () => void {
    return this.#process.onClose(listener);
  }

  async dispose(): Promise<void> {
    if (this.#state.type === "disposed") return;
    this.#state = { type: "disposed" };
    await this.#process.dispose();
  }

  #accept(record: Record<string, unknown>): void {
    const params = asRecord(record.params);
    // Item notifications can arrive after turn/completed. They must not revive
    // Activity for an idle session, including completion before turn/start replies.
    if (
      typeof record.method === "string" &&
      (record.method.startsWith("item/") || record.method === "thread/tokenUsage/updated")
    ) {
      if (!this.#acceptsTurnItem(params)) return;
      this.#signals.markEvidence();
      if (record.method === "thread/tokenUsage/updated") return;
    }
    const signalEvents = this.#signals.notification(record, params);
    if (signalEvents) {
      this.#emitAll(signalEvents);
      return;
    }
    if (record.method === "error") {
      const error = asRecord(params?.error);
      if (
        params?.threadId !== this.#threadId ||
        typeof params.turnId !== "string" ||
        typeof params.willRetry !== "boolean" ||
        typeof error?.message !== "string"
      )
        return;
      if (params.willRetry) {
        logger.debug("Codex is retrying a provider request", {
          event: "codex.request.retrying",
          agent_id: this.#agentId,
          runtime_id: this.#runtimeId,
        });
        return;
      }
      this.#emit({ type: "error", message: error.message, occurredAt: eventTime(record) });
      return;
    }
    if (record.method === "turn/started") {
      const turn = asRecord(params?.turn);
      // Same fence as an item: only this thread's live turn opens a run.
      if (
        typeof turn?.id !== "string" ||
        !this.#acceptsTurnItem({ threadId: params?.threadId, turnId: turn.id })
      )
        return;
      this.#signals.reset();
      this.#emitAll(this.#itemEvents.accept(record, params));
      return;
    }
    const deltas = this.#itemEvents.delta(record, params);
    if (deltas) {
      this.#emitAll(deltas);
      return;
    }
    if (record.method === "item/started") {
      const item = asRecord(params?.item);
      if (item?.type === "commandExecution" && typeof item.id === "string")
        this.#commandOutputBytes.set(item.id, 0);
      this.#emitAll(this.#itemEvents.accept(record, params));
      return;
    }
    if (
      record.method === "item/commandExecution/outputDelta" &&
      typeof params?.itemId === "string" &&
      typeof params.delta === "string"
    ) {
      this.#commandOutputBytes.set(
        params.itemId,
        (this.#commandOutputBytes.get(params.itemId) ?? 0) +
          utf8Encoder.encode(params.delta).byteLength,
      );
      this.#emit({
        type: "tool-output",
        id: params.itemId,
        text: params.delta,
      });
      return;
    }
    if (record.method === "item/completed") {
      const item = asRecord(params?.item);
      if (item?.type === "commandExecution" && typeof item.id === "string") {
        logger.info("Codex command completed", {
          event: "codex.command.completed",
          agent_id: this.#agentId,
          runtime_id: this.#runtimeId,
          exit_code: typeof item.exitCode === "number" ? item.exitCode : undefined,
          output_bytes: this.#commandOutputBytes.get(item.id) ?? 0,
          outcome: item.exitCode === 0 ? "ok" : "failed",
        });
        this.#commandOutputBytes.delete(item.id);
      }
      this.#emitAll(this.#itemEvents.accept(record, params));
      return;
    }
    if (record.method === "turn/completed") {
      const turn = asRecord(params?.turn);
      if (typeof turn?.id !== "string") return;
      if (turn.id === this.#lastCompletedTurnId) return;
      if (this.#state.type === "starting") this.#state.completedTurnIds.add(turn.id);
      else if (
        (this.#state.type === "running" || this.#state.type === "interrupting") &&
        this.#state.turnId === turn.id
      ) {
        this.#state = { type: "idle" };
      } else {
        return;
      }
      this.#commandOutputBytes.clear();
      this.#itemEvents.reset();
      this.#lastCompletedTurnId = turn.id;
      const { status, failure } = codexTurnOutcome(turn);
      if (failure) {
        // The raw message goes to the Activity (the daemon core redacts and truncates it); this
        // local scrub only bounds what reaches the daemon's own structured log line.
        logger.error("Codex turn failed", {
          event: "codex.turn.failed",
          agent_id: this.#agentId,
          runtime_id: this.#runtimeId,
          turn_status: turn.status,
          error_code: failure.code,
          error_message: scrubError(failure.message),
          outcome: "error",
        });
        this.#emit({
          type: "error",
          message: failure.message,
          occurredAt: eventTime(record),
          providerErrorClass: failure.code ?? "CodexTurnError",
          providerErrorReason: "turn_failed",
        });
      }
      this.#emitAll(this.#signals.finish(record, status));
      this.#emit({ type: "completed", status });
    }
  }

  #emit(event: AgentRuntimeEvent): void {
    this.#signals.observe(event);
    for (const listener of this.#listeners) listener(event);
  }

  #emitAll(events: readonly AgentRuntimeEvent[]): void {
    for (const event of events) this.#emit(event);
  }

  #acceptsTurnItem(params: Record<string, unknown> | undefined): boolean {
    if (params?.threadId !== undefined && params.threadId !== this.#threadId) return false;
    const state = this.#state;
    if (state.type === "idle" || state.type === "disposed") return false;
    if (typeof params?.turnId !== "string") return true;
    if (params.turnId === this.#lastCompletedTurnId) return false;
    if (state.type === "starting") return !state.completedTurnIds.has(params.turnId);
    return params.turnId === state.turnId;
  }

  #setIdentity(state: AgentSessionIdentity["state"]): void {
    if (this.#identity.state === state) return;
    this.#identity = { sessionId: this.#threadId, state };
    this.#emit({ type: "session", identity: this.#identity });
  }

  #isDisposed(): boolean {
    return this.#state.type === "disposed";
  }
}
