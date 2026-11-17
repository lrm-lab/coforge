import { AGENT_ACTIVITY_DETAIL_KIND } from "@lrm/coforge-sdk/internal";
import type { AgentRuntimeEvent } from "@lrm/coforge-anvil";

export const ZERO_EVIDENCE_TURN_REASON = "zero_evidence_turn_completed";
export const ZERO_EVIDENCE_TURN_MESSAGE =
  "Agent runtime completed a turn with no assistant text or tool calls (zero_evidence_turn_completed).";

/**
 * Tracks whether the current main-thread turn emitted any assistant text or tool calls before
 * reporting a clean `completed` status. Providers that finish a turn after turn-lifecycle signals
 * (`thinking-delta`, `progress`, `context-usage`, `service-tier`, `model_request_started`) with
 * zero assistant text events and zero tool calls (and no compaction, review, subagent or prior
 * error event) suffered a silent empty completion and must enter retryable error recovery rather
 * than settling as a valid quiet turn.
 */
export class TurnEvidenceLedger {
  #turnObserved = false;
  #assistantTextEvents = 0;
  #toolCalls = 0;
  #exempt = false;

  reset(): void {
    this.#turnObserved = false;
    this.#assistantTextEvents = 0;
    this.#toolCalls = 0;
    this.#exempt = false;
  }

  observe(event: AgentRuntimeEvent): void {
    if (event.conversation) return;
    switch (event.type) {
      case "text-delta":
        if (event.text.length > 0) {
          this.#turnObserved = true;
          this.#assistantTextEvents += 1;
        }
        return;
      case "tool-start":
      case "tool-end":
        this.#turnObserved = true;
        this.#toolCalls += 1;
        return;
      case "thinking-delta":
      case "context-usage":
      case "service-tier":
        this.#turnObserved = true;
        return;
      case "progress":
        if (event.source !== undefined) this.#turnObserved = true;
        return;
      case "compaction-started":
      case "compaction-finished":
      case "review-started":
      case "review-finished":
      case "subagent-progress":
      case "error":
        this.#turnObserved = true;
        this.#exempt = true;
        return;
      case "activity": {
        const kind = event.activity.detailKind;
        if (event.activity.level === "error") {
          this.#turnObserved = true;
          this.#exempt = true;
          return;
        }
        if (kind === AGENT_ACTIVITY_DETAIL_KIND.MODEL_RESPONSE_STARTED) {
          this.#turnObserved = true;
          this.#assistantTextEvents += 1;
          return;
        }
        if (
          kind === AGENT_ACTIVITY_DETAIL_KIND.TOOL_STARTED ||
          kind === AGENT_ACTIVITY_DETAIL_KIND.TOOL_END
        ) {
          this.#turnObserved = true;
          this.#toolCalls += 1;
          return;
        }
        if (
          kind === AGENT_ACTIVITY_DETAIL_KIND.MODEL_REQUEST_STARTED ||
          kind === AGENT_ACTIVITY_DETAIL_KIND.THINKING_STARTED ||
          kind === AGENT_ACTIVITY_DETAIL_KIND.RUNTIME_PROGRESS
        ) {
          this.#turnObserved = true;
        }
        return;
      }
      default:
        return;
    }
  }

  finish(
    status: "completed" | "interrupted" | "failed",
    occurredAt?: string,
  ): Extract<AgentRuntimeEvent, { type: "error" }> | undefined {
    const zeroEvidence =
      status === "completed" &&
      this.#turnObserved &&
      this.#assistantTextEvents === 0 &&
      this.#toolCalls === 0 &&
      !this.#exempt;
    this.reset();
    if (!zeroEvidence) return undefined;
    return {
      type: "error",
      retryable: true,
      message: ZERO_EVIDENCE_TURN_MESSAGE,
      ...(occurredAt ? { occurredAt } : {}),
      providerErrorClass: "ZeroEvidenceTurn",
      providerErrorReason: ZERO_EVIDENCE_TURN_REASON,
    };
  }
}
