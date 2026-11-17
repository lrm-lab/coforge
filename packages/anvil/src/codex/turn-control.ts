import type { AgentRuntimeEvent, AgentSessionIdentity } from "@coforge/agent";
import { JsonlRequestError, asRecord } from "@lrm/coforge-anvil";
import type { JsonlProcess } from "@lrm/coforge-anvil/execution";
import {
  RUNTIME_PROVIDER,
  thrownMessage,
  type AgentServiceTierObserved,
} from "@lrm/coforge-sdk/internal";
import { getLogger } from "@logtape/logtape";
import { scrubError, type CodexSessionState } from "./provider-support";

const logger = getLogger(["coforge", "daemon", "code-agent", RUNTIME_PROVIDER.CODEX]);

export class CodexTurnControl {
  readonly #process: JsonlProcess;
  readonly #threadId: string;
  readonly #agentId: string | undefined;
  readonly #runtimeId: string | undefined;
  readonly #serviceTier: AgentServiceTierObserved | undefined;
  readonly #model: string | undefined;
  readonly #emit: (event: AgentRuntimeEvent) => void;
  readonly #setIdentity: (state: AgentSessionIdentity["state"]) => void;
  #state: CodexSessionState = { type: "idle" };
  /** An interrupt that arrived while `turn/start` was in flight, sent once the turn id is known. */
  #interruptWhileStarting = false;
  #starting: Promise<void> | undefined;
  #serviceTierReported = false;

  constructor(options: {
    process: JsonlProcess;
    threadId: string;
    agentId?: string;
    runtimeId?: string;
    serviceTier?: AgentServiceTierObserved;
    model?: string;
    emit: (event: AgentRuntimeEvent) => void;
    setIdentity: (state: AgentSessionIdentity["state"]) => void;
  }) {
    this.#process = options.process;
    this.#threadId = options.threadId;
    this.#agentId = options.agentId;
    this.#runtimeId = options.runtimeId;
    this.#serviceTier = options.serviceTier;
    this.#model = options.model;
    this.#emit = options.emit;
    this.#setIdentity = options.setIdentity;
  }

  get state(): CodexSessionState {
    return this.#state;
  }

  set state(next: CodexSessionState) {
    this.#state = next;
  }

  set starting(next: Promise<void> | undefined) {
    this.#starting = next;
  }

  get starting(): Promise<void> | undefined {
    return this.#starting;
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
          ...(this.#model ? { model: this.#model } : {}),
        },
      });
    } catch (error) {
      if (!this.isDisposed()) this.beginIdle();
      throw error;
    }
    const turn = asRecord(asRecord(response.result)?.turn);
    const turnId = turn?.id;
    if (typeof turnId !== "string") {
      if (!this.isDisposed()) this.beginIdle();
      throw new Error("Codex did not create a turn");
    }
    this.#setIdentity("resumable");
    // A disposed session keeps its state, and an interrupt has nothing to act on.
    if (this.#state.type !== "starting") return;
    // A turn that completed before its `turn/start` reply was read is already over.
    if (this.#state.completedTurnIds.has(turnId)) {
      this.beginIdle();
      return;
    }
    this.#state = { type: "running", turnId };
    if (this.#interruptWhileStarting) {
      this.#interruptWhileStarting = false;
      // The caller of `interrupt()` has already returned, so a failure here has no caller to
      // reach: say it in the log and leave the turn running for the daemon's stop to retry. A
      // turn that ended anyway is what the interrupt asked for, so it is not a failure.
      // Not awaited: `sendMessage` resolves at turn start, and an app-server that never answers
      // `turn/interrupt` must not hold the send (and every notice queued behind it) open.
      void this.interrupt().catch((error: unknown) => {
        if (!this.#isLiveTurn(turnId)) return;
        logger.warning("Codex could not interrupt the turn it had just started", {
          event: "codex.interrupt.failed",
          agent_id: this.#agentId,
          runtime_id: this.#runtimeId,
          error_message: scrubError(thrownMessage(error)),
          outcome: "error",
        });
      });
    }
  }

  /** Whether this turn is still the one the session is running or interrupting. */
  #isLiveTurn(turnId: string): boolean {
    const state = this.#state;
    return (
      !this.isDisposed() &&
      (state.type === "running" || state.type === "interrupting") &&
      state.turnId === turnId
    );
  }

  /** Back to idle from anywhere but disposal, forgetting an interrupt that had no turn to act on. */
  beginIdle(): void {
    this.#interruptWhileStarting = false;
    this.#state = { type: "idle" };
  }

  consumePendingInterrupt(): boolean {
    if (!this.#interruptWhileStarting) return false;
    this.#interruptWhileStarting = false;
    return true;
  }

  async acceptNotice(notice: string): Promise<void> {
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

  async interrupt(): Promise<void> {
    if (this.#state.type === "starting") {
      // The turn id is not known until `turn/start` answers, so the interrupt cannot be sent yet.
      // Remember it and send it the moment the turn begins; dropping it would let the turn run on
      // against the user's stop (task #703).
      this.#interruptWhileStarting = true;
      return;
    }
    if (this.#state.type !== "running") return;
    const turnId = this.#state.turnId;
    this.#state = { type: "interrupting", turnId };
    try {
      await this.#process.request({
        method: "turn/interrupt",
        params: { threadId: this.#threadId, turnId },
      });
    } catch (error) {
      // Roll back only this turn's own interrupting: the turn may have completed while the
      // request was in flight, and a session that is idle then must stay idle (task #703).
      const state = this.#state;
      if (!this.isDisposed() && state.type === "interrupting" && state.turnId === turnId)
        this.#state = { type: "running", turnId };
      throw error;
    }
  }

  isDisposed(): boolean {
    return this.#state.type === "disposed";
  }
}
