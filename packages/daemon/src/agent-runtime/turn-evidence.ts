import { AGENT_ACTIVITY_DETAIL_KIND } from "@lrm/coforge-sdk/internal";
import type { AgentRuntimeEvent } from "@lrm/coforge-anvil";

export const ZERO_EVIDENCE_TURN_REASON = "zero_evidence_turn_completed";
export const ZERO_EVIDENCE_TURN_MESSAGE =
  "Agent runtime completed a turn with no assistant text or tool calls (zero_evidence_turn_completed).";

export class TurnEvidenceLedger {
  #turnObserved = false;
  #opened = false;
  readonly #bareCompletionIsEmpty: boolean;
  #assistantTextEvents = 0;
  #toolCalls = 0;
  #exempt = false;
  #inputAllowsEmptyCompletion: boolean | undefined;

  constructor(options: { bareCompletionIsEmpty?: boolean } = {}) {
    this.#bareCompletionIsEmpty = options.bareCompletionIsEmpty === true;
  }

  reset(): void {
    this.#turnObserved = false;
    this.#opened = false;
    this.#assistantTextEvents = 0;
    this.#toolCalls = 0;
    this.#exempt = false;
    this.#inputAllowsEmptyCompletion = undefined;
  }

  markExempt(): void {
    this.#exempt = true;
  }

  noteInputAllowsEmptyCompletion(allows: boolean): void {
    this.#inputAllowsEmptyCompletion =
      this.#inputAllowsEmptyCompletion === undefined
        ? allows
        : this.#inputAllowsEmptyCompletion && allows;
  }

  markOpened(): void {
    if (this.#bareCompletionIsEmpty) this.#opened = true;
  }

  noteMessageSent(): void {
    this.#turnObserved = true;
    this.#assistantTextEvents += 1;
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
      (this.#turnObserved || this.#opened) &&
      this.#assistantTextEvents === 0 &&
      this.#toolCalls === 0 &&
      !this.#exempt &&
      this.#inputAllowsEmptyCompletion !== true;
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
