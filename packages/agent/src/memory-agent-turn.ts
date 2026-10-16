import {
  MEMORY_OFFER_BUDGET_PER_TRIGGER,
  OPENVIKING_CANDIDATE_LIMIT_MAX,
  type OpenVikingAgentCommand,
  type OpenVikingAgentResponse,
} from "@lrm/coforge-sdk/agent";

const MEMORY_READ_OPS = new Set(["find", "search_context", "read", "expand"]);

/** Per-trigger Offer budget and read accounting for the Memory Agent fence. */
export class MemoryAgentTurnBudget {
  #offerPayloads = new Map<string, { payload: string; trigger: number }>();
  #trigger = 0;
  #reads = 0;
  #offers = 0;
  #evidence = new Set<string>();
  #citationRefs = new Set<string>();
  #unchangedReads = 0;
  #discoveriesWithoutRead = 0;
  #verifiedReads = new Set<string>();

  reset(): void {
    // Offer IDs remain reserved across triggers within this live session.
    this.#trigger++;
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
      const payload = JSON.stringify([command.body, [...command.citationRefs].sort()]);
      const previous = this.#offerPayloads.get(command.operationId);
      if (previous !== undefined && previous.payload !== payload)
        throw new Error(
          "operationId already used for a different Offer; use a new operationId for new findings or a new request. Keep the same id only for an identical retry.",
        );
      if (previous !== undefined && previous.trigger !== this.#trigger)
        throw new Error(
          "operationId belongs to an earlier triggering request; use a new id to publish an Offer for this request.",
        );
      if (this.#offers >= MEMORY_OFFER_BUDGET_PER_TRIGGER)
        throw new Error("memory offer budget exhausted for this triggering message");
      this.#offerPayloads.set(command.operationId, { payload, trigger: this.#trigger });
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
        response.op === "read" ? citation.excerpt : undefined,
      ]);
      this.#citationRefs.add(citation.citationId);
      if (!this.#evidence.has(key)) {
        this.#evidence.add(key);
        newEvidence++;
      }
    }
    this.#unchangedReads = newEvidence > 0 ? 0 : this.#unchangedReads + 1;
    // A new search hit is discovery, not verification. Keep this progress across
    // Task follow-ups so rephrasing a request cannot hide a search-only loop.
    if (response.op === "find" || response.op === "search_context") this.#discoveriesWithoutRead++;
    if (response.op === "read" && !response.citation.uri.startsWith("viking://resources/causal/")) {
      const key = JSON.stringify([
        response.citation.uri,
        response.citation.contentHash ?? response.citation.contentVersion,
        new Bun.CryptoHasher("sha256").update(response.content).digest("hex"),
      ]);
      if (!this.#verifiedReads.has(key)) {
        this.#verifiedReads.add(key);
        this.#discoveriesWithoutRead = 0;
      }
    }
    const feedback: string[] = [];
    if (this.#discoveriesWithoutRead >= 3) {
      const candidate = citations.find(
        (citation) => !citation.uri.startsWith("viking://resources/causal/"),
      );
      feedback.push(
        `${this.#discoveriesWithoutRead} discovery calls without a new document read. New snippets and new IDs do not verify the Task's constraints. Before another keyword variant, read a relevant candidate and test a specific unresolved constraint; also try to disconfirm the leading hypothesis. ` +
          (candidate
            ? "For this returned document, ov_read accepts " +
              JSON.stringify({
                operationId: `verify-${this.#trigger}-${this.#discoveriesWithoutRead}`,
                uri: candidate.uri,
              }) +
              ". Choose by relevance; the first hit is not automatically correct. "
            : "If no returned document is relevant, explain that mismatch and pivot to a different constraint. ") +
          "Quotes, wildcards and date ranges are not BM25 filters. Use short discriminating words. If reading cannot resolve the gap, publish supported findings and explicit unknowns rather than another list of near-identical queries. Repeated Task failures may warrant memory_diagnose anchored to an actual Task message. Retrieval remains unlimited.",
      );
    }
    if (
      response.op === "find" &&
      response.retrieval &&
      !response.retrieval.exhausted &&
      response.retrieval.remainingHops > 0
    ) {
      const fork = response.retrieval.nodes.find(
        (node) => node.kind === "fork_overlay" && node.relations.includes("branch_steps"),
      );
      if (fork)
        feedback.push(
          "Fork candidates are method proposals, not factual answer evidence. Before adopting a candidate method, inspect its branch steps. For this served candidate you can call ov_expand with " +
            JSON.stringify({
              operationId: `${response.operationId}-steps`,
              chainRef: response.retrieval.chainRef,
              uri: fork.uri,
              relation: "branch_steps",
              limit: 5,
            }) +
            ". Choose the candidate that fits the Task; follow next only on returned steps. If none fits, explain the mismatch and continue factual retrieval.",
        );
    }
    if (this.#unchangedReads < 2) return feedback.length ? feedback.join("\n") : undefined;
    const next =
      this.#citationRefs.size > 0
        ? "Publish a partial cited memory_offer with useful findings and explicit unresolved constraints, or change strategy: use ov_read on promising documents; for a method gap, search viking://resources/causal/forks using an abstract failure or reasoning pattern, then expand served branch_steps/next relations. If Task's observed state shows repeated failures or unresolved constraints, read its exact channel/thread update and decide whether memory_diagnose would help; do not diagnose your own Offer or routine progress. A changed snippet of an unchanged source is not a new source. Do not wait to solve the entire Task before replying."
        : "Use a materially different query. No citation has been retrieved; do not fabricate evidence or citations.";
    feedback.push(
      `No new evidence in ${this.#unchangedReads} consecutive retrievals. ${next} Available citationRefs: ${[...this.#citationRefs].slice(-10).join(", ")}`,
    );
    return feedback.join("\n");
  }

  snapshot() {
    return {
      reads: this.#reads,
      offers: this.#offers,
    };
  }
}
