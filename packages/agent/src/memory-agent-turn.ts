import {
  MEMORY_OFFER_BUDGET_PER_TRIGGER,
  OPENVIKING_CANDIDATE_LIMIT_MAX,
  type OpenVikingAgentCommand,
  type OpenVikingAgentResponse,
} from "@lrm/coforge-sdk/agent";

const MEMORY_READ_OPS = new Set(["find", "search_context", "read", "expand"]);

/** Per-trigger Offer budget and read accounting for the Memory Agent fence. */
export class MemoryAgentTurnBudget {
  #reads = 0;
  #offers = 0;
  #evidence = new Set<string>();
  #citationRefs = new Set<string>();
  #unchangedReads = 0;

  reset(): void {
    this.#reads = 0;
    this.#offers = 0;
    this.#evidence.clear();
    this.#citationRefs.clear();
    this.#unchangedReads = 0;
  }

  consume(command: OpenVikingAgentCommand): void {
    if (MEMORY_READ_OPS.has(command.op)) {
      const limit = "limit" in command ? command.limit : undefined;
      if (limit !== undefined && limit > OPENVIKING_CANDIDATE_LIMIT_MAX)
        throw new Error("candidate limit exceeded");
      this.#reads += 1;
      return;
    }
    if (command.op === "offer") {
      if (this.#offers >= MEMORY_OFFER_BUDGET_PER_TRIGGER)
        throw new Error("memory offer budget exhausted for this triggering message");
      this.#offers += 1;
    }
  }

  retrievalFeedback(response: OpenVikingAgentResponse): string | undefined {
    if (!MEMORY_READ_OPS.has(response.op)) return undefined;
    const citations =
      response.op === "read" ? [response.citation] : "items" in response ? response.items : [];
    let newEvidence = 0;
    for (const citation of citations) {
      const key = JSON.stringify([
        response.op === "read" ? "read" : "discovery",
        citation.citationId,
        citation.contentHash ?? citation.contentVersion,
        citation.excerpt,
      ]);
      this.#citationRefs.add(citation.citationId);
      if (!this.#evidence.has(key)) {
        this.#evidence.add(key);
        newEvidence++;
      }
    }
    this.#unchangedReads = newEvidence > 0 ? 0 : this.#unchangedReads + 1;
    if (this.#unchangedReads < 2) return undefined;
    const next =
      this.#citationRefs.size > 0
        ? "Publish a partial cited memory_offer with useful findings and explicit unresolved constraints, or use a materially different query. Do not wait to solve the entire Task before replying."
        : "Use a materially different query. No citation has been retrieved; do not fabricate evidence or citations.";
    return `No new evidence in ${this.#unchangedReads} consecutive retrievals. ${next} Available citationRefs: ${[...this.#citationRefs].slice(-10).join(", ")}`;
  }

  snapshot() {
    return {
      reads: this.#reads,
      offers: this.#offers,
    };
  }
}
