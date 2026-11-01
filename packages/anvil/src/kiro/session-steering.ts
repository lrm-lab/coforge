import type { AgentNoticeOptions, AgentRuntimeEvent } from "@coforge/agent";
import type { SessionNotification } from "@agentclientprotocol/sdk";

/** How long a turn end waits for the steering outcome Kiro wrote before its prompt response. The
 * frames are already on the wire, so this only bounds a pathological dispatch delay. */
export const STEERING_OUTCOME_WAIT_MS = 1_000;

/** A steer Kiro queued: the notice text sent under it, and whether its own `steering_injected`
 * update has since confirmed the model read it. */
type SteeredMessage = {
  text: string;
  injected: boolean;
  options?: AgentNoticeOptions;
};

/** What a Kiro session supplies to its steering: the ACP extension calls, its own live state, and
 * the event sink a never-delivered notice is reported through. */
export type KiroTurnSteeringPorts = {
  /** Whether the session can still take input (not disposed or interrupting, identity known). */
  acceptsInput(): boolean;
  sessionId(): string;
  /** Whether a turn is live: only a live turn is steered rather than prompted. */
  hasLiveTurn(): boolean;
  /** One bounded ACP request on the live connection. */
  request<Response, Params>(method: string, params: Params): Promise<Response>;
  emit(event: AgentRuntimeEvent): void;
};

/**
 * Busy-turn steering for one Kiro session: Kiro's undocumented `_session/steer` ACP extension
 * (measured against kiro-cli 2.22.0, 2026-09-18), the outcome its `steering_injected` /
 * `steering_cleared` updates report, and the `notice-undelivered` event a steer that never
 * reached the model produces.
 */
export class KiroTurnSteering {
  /** Native ACP `steer-<uuid>` id -> the notice text sent under it and whether Kiro's own
   * `steering_injected` update has since confirmed the model read it. Populated only by a
   * `_session/steer` call that returned `queued: true`; drained by the matching
   * `steering_cleared` (Kiro's `steer` delivery mode). */
  readonly #steeredMessages = new Map<string, SteeredMessage>();
  /** Wakes `settle` when a steering outcome arrives. */
  #observed: (() => void) | undefined;

  constructor(private readonly ports: KiroTurnSteeringPorts) {}

  /**
   * Injects `message` into the running turn via Kiro's undocumented `_session/steer` ACP
   * extension. Resolves once Kiro accepts it (`queued: true`); a later `steering_cleared` for this
   * id with no prior `steering_injected` means Kiro's own buffer discarded it before the model ever
   * read it, and emits the fallback `notice-undelivered` event for the daemon core to redeliver
   * once idle.
   *
   * When the extension rejects the call outright (unknown method, an unrelated throw) or answers
   * `queued: false` (a turn boundary raced its own persistence — `dropped: "epoch_changed"`), this
   * notice was never accepted at all: emit the same fallback event immediately and reject, so the
   * daemon core never ACKs a delivery that never reached the model.
   */
  async steer(message: string, options?: AgentNoticeOptions): Promise<void> {
    if (!this.ports.acceptsInput()) throw new Error("Kiro cannot accept input");
    const sessionId = this.ports.sessionId();
    let response: { queued: boolean; messageId: string; dropped?: string } | undefined;
    try {
      response = await this.ports.request("_session/steer", { sessionId, message });
    } catch {
      // Falls through to the shared "not accepted" handling below.
    }
    if (response?.queued && this.ports.hasLiveTurn()) {
      this.#steeredMessages.set(response.messageId, { text: message, injected: false, options });
      return;
    }
    if (response?.queued)
      // The turn ended while Kiro was queueing the steer: no turn will read it, so take it back
      // out of Kiro's buffer before the daemon redelivers it as the next prompt.
      await this.ports.request("_session/steer/clear", { sessionId }).catch(() => {});
    // Not steered, but still accepted: the daemon core redelivers this text once the Agent is
    // idle (`notice-undelivered`). Resolving keeps the delivery's single ACK; rejecting would
    // leave it unacknowledged and the server would redeliver it on top of the fallback.
    this.#emitUndelivered(message, options);
  }

  /** Reads the steering outcome a `session/update` carries, if it carries one. */
  observe(update: SessionNotification["update"], meta: Record<string, unknown> | undefined): void {
    if (update.sessionUpdate !== "session_info_update") return;
    if (meta?.kind === "steering_injected" && typeof meta.messageId === "string") {
      const entry = this.#steeredMessages.get(meta.messageId);
      if (entry) entry.injected = true;
      this.#observed?.();
    }
    if (meta?.kind === "steering_cleared" && Array.isArray(meta.messageIds)) {
      // Kiro clears its whole steering buffer at every non-cancelled turn end (after retrying
      // delivery for up to 3 further turns) and on session/cancel; the cleared id list can
      // include ids already confirmed via `steering_injected`. Only a still-unconfirmed one
      // means the model never actually read it - that one alone needs redelivery.
      for (const id of meta.messageIds) {
        if (typeof id !== "string") continue;
        const entry = this.#steeredMessages.get(id);
        this.#steeredMessages.delete(id);
        if (entry && !entry.injected) this.#emitUndelivered(entry.text, entry.options);
      }
      this.#observed?.();
    }
  }

  /**
   * Settles this turn's steers before the turn is reported ended. Kiro writes a turn's steering
   * outcome before its prompt response: `acp-server.js` (kiro-cli 2.24.1) runs
   * `clearSteeringAtTurnBoundary` — `steering_cleared` for every unread steer, after its own
   * continuation retries — before `return {stopReason}`, and a cancel clears the buffer first.
   * The ACP client dispatches notifications through async handlers, though, so a
   * `steering_injected`/`steering_cleared` written before the response can still reach `observe`
   * after it. Waits (at most `STEERING_OUTCOME_WAIT_MS`) until every steer is injected or
   * cleared; one still unconfirmed then never reached the model and is reported undelivered —
   * before `completed`, whose listener settles what that turn was told.
   */
  async settle(): Promise<void> {
    // This turn's steers only: a turn prompted while this one waits steers its own.
    const turnSteers = [...this.#steeredMessages.keys()];
    const unconfirmed = () =>
      turnSteers.some((id) => this.#steeredMessages.get(id)?.injected === false);
    const deadline = Date.now() + STEERING_OUTCOME_WAIT_MS;
    while (unconfirmed() && this.ports.acceptsInput()) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const observed = Promise.withResolvers<void>();
      this.#observed = observed.resolve;
      const timer = setTimeout(observed.resolve, remaining);
      await observed.promise;
      clearTimeout(timer);
      this.#observed = undefined;
    }
    for (const id of turnSteers) {
      const entry = this.#steeredMessages.get(id);
      this.#steeredMessages.delete(id);
      if (entry && !entry.injected) this.#emitUndelivered(entry.text, entry.options);
    }
  }

  /** Forgets every steer, as a disposed session does. */
  clear(): void {
    this.#steeredMessages.clear();
  }

  /** A notice that never reached the model, named with the deliveries `notify` said it carried. */
  #emitUndelivered(text: string, options: AgentNoticeOptions | undefined): void {
    this.ports.emit({
      type: "notice-undelivered",
      text,
      ...(options?.deliveryIds?.length ? { deliveryIds: options.deliveryIds } : {}),
    });
  }
}
