import { RequestError } from "@agentclientprotocol/sdk";
import type { AgentNoticeOptions, AgentRuntimeEvent } from "@coforge/agent";
import type { AcpSteerProfile } from "./profile";

/** A steer the runtime took: the notice text sent under it, and whether delivery was confirmed. */
type Steer = {
  text: string;
  options?: AgentNoticeOptions;
  injected: boolean;
};

type Admission = ReturnType<typeof Promise.withResolvers<void>>;

const SEEN_LIMIT = 256;

/** What a session supplies to its busy-turn insertion: its live state and its own effects. */
export type AcpSteeringPorts = Readonly<{
  /** The session can still take input (not disposed, failed or interrupting). */
  acceptsInput(): boolean;
  sessionId(): string;
  /** Whether a turn is live: only a live turn is steered rather than prompted. */
  turnIsLive(): boolean;
  generation(): number;
  /** One bounded ACP request on the live connection. */
  request(method: string, params: unknown): Promise<unknown>;
  /** Closes the session after an answer that never came. */
  dispose(): Promise<void>;
  emit(event: AgentRuntimeEvent, options?: AgentNoticeOptions): void;
  markResumable(options?: AgentNoticeOptions): void;
}>;

/**
 * Busy-turn insertion for one session: the runtime's own request, the single delivery
 * acknowledgement it answers, and the outcomes it may report itself. A refusal is reported as
 * `notice-undelivered` for the daemon to redeliver once idle; an unanswered request leaves the
 * outcome unknown and closes the session before rejecting.
 */
export class AcpSteering {
  /** Steers the runtime took and has not yet reported delivered. */
  readonly #steers = new Map<string, Steer>();
  /** Steer outcomes that arrived before the answer that named their steer. */
  readonly #earlyOutcomes = new Map<string, "injected" | "cleared">();
  readonly #pending = new Set<Admission>();
  #chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly label: string,
    private readonly profile: AcpSteerProfile,
    private readonly ports: AcpSteeringPorts,
  ) {}

  /**
   * Inserts a notice into the live turn. Notices reach the runtime one at a time, and each waits
   * for the previous notice's admission, as busy input did before this path existed.
   */
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
    const work = this.#chain
      .then(() => prior)
      .then(() => this.#insert(text, options, admission, generation));
    this.#chain = work.catch(() => undefined);
    return admission.promise;
  }

  /** Reads a notification's steer outcome; false when the notification carries none. */
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

  /** A steer the turn ended without the runtime confirming never reached the model. */
  settle(): void {
    for (const entry of this.#steers.values())
      if (!entry.injected) this.#undeliver(entry.text, entry.options);
    this.#steers.clear();
    this.#earlyOutcomes.clear();
  }

  /** Rejects every notice still waiting to be sent, as a cancelled or disposed session does. */
  rejectPending(message: string): void {
    for (const admission of this.#pending) admission.reject(new Error(message));
    this.#pending.clear();
  }

  clear(): void {
    this.#steers.clear();
    this.#earlyOutcomes.clear();
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
    const request = this.profile.request(text, this.ports.sessionId());
    let response: unknown;
    try {
      response = await this.ports.request(request.method, request.params);
    } catch (error) {
      if (cancelled()) {
        admission.reject(new Error(`${this.label} notice cancelled`));
      } else if (error instanceof RequestError) {
        undeliver();
      } else {
        // No answer: the runtime may hold the notice. Close the ambiguous session before
        // rejecting, so neither a late acceptance nor a retry can escape the fence.
        await this.ports.dispose().catch(() => undefined);
        admission.reject(new Error(`${this.label} input delivery outcome is unknown`));
      }
      return;
    }
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
      // The turn ended while the runtime was queueing the steer: no turn will read it, so take
      // it back before the daemon redelivers it as the next prompt.
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
    admission.resolve();
    this.ports.markResumable(options);
  }

  /** A notice the runtime refused or dropped: one ACK, redelivered by the daemon when idle. */
  #undeliver(text: string, options?: AgentNoticeOptions) {
    this.ports.emit(
      {
        type: "notice-undelivered",
        text,
        ...(options?.deliveryIds?.length ? { deliveryIds: options.deliveryIds } : {}),
      },
      options,
    );
  }
}
