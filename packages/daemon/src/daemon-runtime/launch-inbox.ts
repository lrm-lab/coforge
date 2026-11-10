import type { AgentMessageDelivery } from "@lrm/coforge-sdk/internal";
import type { CarriedStart } from "./provider-replay-recovery";
import type { AgentInputQueue } from "./runtime-launch-intent";

/**
 * Everything the daemon keeps for one Agent's next input, in one place: the deliveries held for
 * it, oldest first, and what a cold start still owes it. It outlives the Agent's launches.
 */
export class LaunchInbox {
  /** Deliveries held for a later notice or launch, oldest first. */
  held: AgentMessageDelivery[] = [];
  /** When the oldest held delivery began waiting; the stall sweep's clock for a delivery whose
   * turn never started. */
  heldSince: number | undefined;
  /** What a cold start of a rejected Session did not finish telling the Agent. */
  owed: CarriedStart | undefined;
  /** The input the launch drains in order: deliveries, prompts, the startup input, recovery. */
  input: AgentInputQueue | undefined;

  /** Holds a delivery. A resend of one already held is the same delivery: it takes the earlier
   * entry's place, so the wait the oldest has put in is not restarted. */
  hold(message: AgentMessageDelivery): void {
    if (this.held.length === 0) this.heldSince = Date.now();
    const held = this.held.findIndex((entry) => entry.deliveryId === message.deliveryId);
    if (held >= 0) this.held[held] = message;
    else this.held.push(message);
  }

  /** Removes and returns the held deliveries that `dropped` selects, leaving the rest held. */
  takeHeldWhere(dropped: (message: AgentMessageDelivery) => boolean): AgentMessageDelivery[] {
    const gone: AgentMessageDelivery[] = [];
    const kept: AgentMessageDelivery[] = [];
    for (const message of this.held) (dropped(message) ? gone : kept).push(message);
    this.held = kept;
    if (!kept.length) this.heldSince = undefined;
    return gone;
  }

  /** Settles the queued input deliveries that `settle` takes: each is removed and its completion
   * resolved. */
  dropInputDeliveries(settle: (message: AgentMessageDelivery) => boolean): void {
    const queue = this.input;
    if (!queue) return;
    queue.items = queue.items.filter((item) => {
      if (item.kind !== "delivery" || !settle(item.message)) return true;
      item.completion.resolve();
      return false;
    });
  }

  /** Whether nothing is held, owed or queued as input. */
  get empty(): boolean {
    return this.held.length === 0 && this.owed === undefined && this.input === undefined;
  }
}

/** The Agents' inboxes. An inbox exists only while it holds something. */
export class LaunchInboxes {
  readonly #inboxes = new Map<string, LaunchInbox>();

  /** The Agent's inbox, created when it has none. */
  of(agentId: string): LaunchInbox {
    const existing = this.#inboxes.get(agentId);
    if (existing) return existing;
    const created = new LaunchInbox();
    this.#inboxes.set(agentId, created);
    return created;
  }

  /** The Agent's inbox, when it holds something. */
  peek(agentId: string): LaunchInbox | undefined {
    return this.#inboxes.get(agentId);
  }

  /** Drops the Agent's inbox once it is empty; call after anything that emptied it. */
  tidy(agentId: string): void {
    if (this.#inboxes.get(agentId)?.empty) this.#inboxes.delete(agentId);
  }

  /** Every Agent's input queue. */
  inputs(): [string, AgentInputQueue][] {
    return [...this.#inboxes].flatMap(([agentId, { input }]) => (input ? [[agentId, input]] : []));
  }

  /** Forgets what a cold start owed the Agent. */
  dropOwed(agentId: string): void {
    const inbox = this.#inboxes.get(agentId);
    if (!inbox) return;
    inbox.owed = undefined;
    this.tidy(agentId);
  }

  /** Forgets what a cold start owed any Agent. */
  clearOwed(): void {
    for (const agentId of this.#inboxes.keys()) this.dropOwed(agentId);
  }
}
