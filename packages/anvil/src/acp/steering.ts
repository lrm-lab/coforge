import { RequestError } from "@agentclientprotocol/sdk/unstable";
import type { AgentNoticeOptions, AgentRuntimeEvent, AgentTurnTokenUsage } from "@coforge/agent";
import { acpPromptTokenUsage } from "#src/acp-context-usage";
import { AGENT_RUNTIME_EVENT_TYPE } from "#src/contract";
import type { AcpSteerProfile } from "./profile";

type Steer = {
  text: string;
  options?: AgentNoticeOptions;
  injected: boolean;
};

type Admission = ReturnType<typeof Promise.withResolvers<void>>;

const SEEN_LIMIT = 256;

export type AcpSteeringPorts = Readonly<{
  acceptsInput(): boolean;
  sessionId(): string;
  turnIsLive(): boolean;
  generation(): number;
  request(method: string, params: unknown): Promise<unknown>;
  dispose(): Promise<void>;
  emit(event: AgentRuntimeEvent, options?: AgentNoticeOptions): void;
  markResumable(options?: AgentNoticeOptions): void;
  isDisposed?(): boolean;
  onTokenUsage?(usage: AgentTurnTokenUsage, options?: AgentNoticeOptions): void;
  turnFailure?(response: unknown): Extract<AgentRuntimeEvent, { type: "error" }> | undefined;
  rpcFailure?(error: unknown): Extract<AgentRuntimeEvent, { type: "error" }>;
}>;

export class AcpSteering {
  readonly #steers = new Map<string, Steer>();
  readonly #earlyOutcomes = new Map<string, "injected" | "cleared">();
  readonly #pending = new Set<Admission>();
  readonly #inflight = new Set<Promise<void>>();
  #chain: Promise<void> = Promise.resolve();
  #turnStatus: "failed" | undefined;
  #settledBySteer = false;

  constructor(
    private readonly label: string,
    private readonly profile: AcpSteerProfile,
    private readonly ports: AcpSteeringPorts,
  ) {}

  offer(
    text: string,
    options: AgentNoticeOptions | undefined,
    admission: Admission,
    prior: Promise<void>,
  ): Promise<void> {
    const generation = this.ports.generation();
    this.#pending.add(admission);
    void admission.promise.then(
      () => this.#pending.delete(admission),
      () => this.#pending.delete(admission),
    );
    if (this.profile.unboundedRequest) {
      const work = this.#insert(text, options, admission, generation);
      this.#inflight.add(work);
      void work.finally(() => this.#inflight.delete(work));
      return admission.promise;
    }
    const work = this.#chain
      .then(() => prior)
      .then(() => this.#insert(text, options, admission, generation));
    this.#chain = work.catch(() => undefined);
    return admission.promise;
  }

  async drain(
    initialResponse?: unknown,
    initialOptions?: AgentNoticeOptions,
  ): Promise<"failed" | undefined> {
    while (this.#inflight.size > 0) await Promise.all(this.#inflight);
    if (
      !this.#turnStatus &&
      !this.#settledBySteer &&
      initialResponse !== undefined &&
      this.profile.settlesTurn
    ) {
      const failure = this.ports.turnFailure?.(initialResponse);
      if (failure) {
        this.ports.emit(failure, initialOptions);
        this.#turnStatus = "failed";
      }
    }
    const status = this.#turnStatus;
    this.#turnStatus = undefined;
    this.#settledBySteer = false;
    return status;
  }

  outcome(method: string, params: Readonly<Record<string, unknown>>): boolean {
    const outcome = this.profile.outcome?.(method, params);
    if (!outcome) return false;
    const entry = this.#steers.get(outcome.id);
    if (!entry) {
      this.#earlyOutcomes.set(outcome.id, outcome.state);
      if (this.#earlyOutcomes.size > SEEN_LIMIT)
        this.#earlyOutcomes.delete(this.#earlyOutcomes.keys().next().value!);
      return true;
    }
    if (outcome.state === "injected") {
      entry.injected = true;
      return true;
    }
    this.#steers.delete(outcome.id);
    if (!entry.injected) this.#undeliver(entry.text, entry.options);
    return true;
  }

  settle(): void {
    for (const entry of this.#steers.values())
      if (!entry.injected) this.#undeliver(entry.text, entry.options);
    this.#steers.clear();
    this.#earlyOutcomes.clear();
    this.#turnStatus = undefined;
    this.#settledBySteer = false;
  }

  rejectPending(message: string): void {
    for (const admission of this.#pending) admission.reject(new Error(message));
    this.#pending.clear();
    this.#turnStatus = undefined;
    this.#settledBySteer = false;
  }

  clear(): void {
    this.#steers.clear();
    this.#earlyOutcomes.clear();
    this.#turnStatus = undefined;
    this.#settledBySteer = false;
  }

  #emitResponseTokenUsage(payload: unknown, options?: AgentNoticeOptions): void {
    if (this.ports.isDisposed?.()) return;
    const usage = acpPromptTokenUsage(payload);
    if (!usage) return;
    if (this.ports.onTokenUsage) {
      this.ports.onTokenUsage(usage, options);
      return;
    }
    this.ports.emit({ type: AGENT_RUNTIME_EVENT_TYPE.TOKEN_USAGE, usage }, options);
  }

  async #insert(
    text: string,
    options: AgentNoticeOptions | undefined,
    admission: Admission,
    generation: number,
  ) {
    const cancelled = () => generation !== this.ports.generation();
    const undeliver = () => {
      this.#undeliver(text, options);
      admission.resolve();
    };
    if (cancelled() || !this.ports.acceptsInput()) {
      admission.reject(new Error(`${this.label} notice cancelled`));
      return;
    }
    if (!this.ports.turnIsLive()) {
      undeliver();
      return;
    }
    const request = this.profile.request(text, this.ports.sessionId());
    let response: unknown;
    try {
      response = await this.ports.request(request.method, request.params);
    } catch (error) {
      if (error instanceof RequestError) this.#emitResponseTokenUsage(error.data, options);
      if (cancelled()) {
        admission.reject(new Error(`${this.label} notice cancelled`));
      } else if (error instanceof RequestError) {
        if (this.profile.settlesTurn && !this.profile.isRefusalError?.(error)) {
          admission.resolve();
          this.ports.markResumable(options);
          const failure = this.ports.rpcFailure?.(error);
          if (failure) this.ports.emit(failure, options);
          this.#settledBySteer = true;
          this.#turnStatus = "failed";
        } else {
          undeliver();
        }
      } else {
        await this.ports.dispose().catch(() => undefined);
        admission.reject(new Error(`${this.label} input delivery outcome is unknown`));
      }
      return;
    }
    this.#emitResponseTokenUsage(response, options);
    if (cancelled()) {
      admission.reject(new Error(`${this.label} notice cancelled`));
      return;
    }
    const taken = this.profile.accepted(response);
    if (!taken.accepted) {
      undeliver();
      return;
    }
    if (!this.ports.turnIsLive() && this.profile.abandon && taken.id) {
      await this.profile.abandon(taken.id).catch(() => undefined);
      if (!cancelled()) undeliver();
      return;
    }
    if (this.profile.outcome && taken.id) {
      const early = this.#earlyOutcomes.get(taken.id);
      this.#earlyOutcomes.delete(taken.id);
      if (early === "cleared") {
        undeliver();
        return;
      }
      this.#steers.set(taken.id, { text, options, injected: early === "injected" });
    }
    if (this.profile.settlesTurn) {
      this.#settledBySteer = true;
      const failure = this.ports.turnFailure?.(response);
      if (failure) {
        this.ports.emit(failure, options);
        this.#turnStatus = "failed";
      }
    }
    admission.resolve();
    this.ports.markResumable(options);
  }

  #undeliver(text: string, options?: AgentNoticeOptions) {
    this.ports.emit(
      {
        type: "notice-undelivered",
        text,
        ...(options?.deliveryIds?.length ? { deliveryIds: options.deliveryIds } : {}),
        ...(options?.fallbackText ? { fallbackText: options.fallbackText } : {}),
      },
      options,
    );
  }
}
