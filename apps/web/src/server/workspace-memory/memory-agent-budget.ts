/**
 * Web-route Memory Agent budget. Consumes the C2 constants that A1 uses;
 * does not copy the numeric limits.
 */

import {
  MEMORY_OFFER_BUDGET_PER_TRIGGER,
  OPENVIKING_CANDIDATE_LIMIT_MAX,
  type OpenVikingAgentCommand,
  type OpenVikingOfferCommand,
  type MemoryOfferPublication,
} from "@lrm/coforge-sdk/agent";

const MEMORY_READ_OPS = new Set(["fork_find", "experience_find", "search_context", "read", "expand"]);

export class MemoryAgentBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemoryAgentBudgetError";
  }
}

/** Per-trigger Offer budget and read accounting. Reads have no per-trigger cap. */
export class MemoryAgentTriggerBudget {
  #reads = 0;
  #offers = 0;
  // A single owner relies on the shared per-trigger Offer quota being one.
  #owner: string | undefined;
  #attempts = new Map<string, { payload: string; pending: boolean; published: boolean }>();

  consume(command: OpenVikingAgentCommand): void {
    if (MEMORY_READ_OPS.has(command.op)) {
      const limit = "limit" in command ? command.limit : undefined;
      if (limit !== undefined && limit > OPENVIKING_CANDIDATE_LIMIT_MAX)
        throw new MemoryAgentBudgetError("candidate limit exceeded");
      this.#reads += 1;
      return;
    }
    if (command.op === "offer") this.acquireOffer(command);
  }

  /** Reserve before awaiting publication; settle only this request's reservation. */
  acquireOffer(command: OpenVikingOfferCommand): (publication?: MemoryOfferPublication) => void {
    const payload = JSON.stringify([
      command.body,
      [...command.citationRefs].sort(),
      command.conversationId,
      command.targetAgentId,
      command.recipientRationale,
    ]);
    const previous = this.#attempts.get(command.operationId);
    if (previous && previous.payload !== payload)
      throw new MemoryAgentBudgetError("operationId already used for a different Offer");
    if (this.#offers >= MEMORY_OFFER_BUDGET_PER_TRIGGER && this.#owner !== command.operationId)
      throw new MemoryAgentBudgetError("memory offer budget exhausted for this triggering message");
    if (previous?.pending)
      throw new MemoryAgentBudgetError("memory Offer request is already pending");
    const entry = previous ?? { payload, pending: false, published: false };
    this.#attempts.set(command.operationId, entry);
    this.#owner = command.operationId;
    this.#offers = 1;
    entry.pending = true;
    let completed = false;
    return (publication) => {
      if (completed) return;
      completed = true;
      entry.pending = false;
      if (publication?.phase === "published") entry.published = true;
      if (
        publication?.phase === "rejected_before_publish" &&
        !entry.published &&
        this.#owner === command.operationId
      ) {
        this.#offers = 0;
        this.#owner = undefined;
      }
    };
  }

  snapshot() {
    return { reads: this.#reads, offers: this.#offers };
  }
}

export type MemoryAgentBudgetLedger = {
  forTrigger(input: {
    workspaceId: string;
    agentId: string;
    triggerMessageId: string;
  }): MemoryAgentTriggerBudget;
};

export function createMemoryAgentBudgetLedger(): MemoryAgentBudgetLedger {
  const budgets = new Map<string, MemoryAgentTriggerBudget>();
  return {
    forTrigger({ workspaceId, agentId, triggerMessageId }) {
      const key = `${workspaceId}:${agentId}:${triggerMessageId}`;
      const existing = budgets.get(key);
      if (existing) return existing;
      const created = new MemoryAgentTriggerBudget();
      budgets.set(key, created);
      return created;
    },
  };
}
