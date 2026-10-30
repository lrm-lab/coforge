import type { AgentMessageRecord, AgentMessageResponse } from "@lrm/coforge-sdk/internal";
import { CliError } from "#src/cli-error";
import { formatHeldSend } from "#src/message-format";

/** A send whose lost answer the daemon confirmed by its key: only its message id is known. */
export type CommittedSendResult = Pick<AgentMessageResponse, "messageId" | "idempotencyKey"> & {
  state: "committed";
};

export function isCommittedSend(result: unknown): result is CommittedSendResult {
  if (!result || typeof result !== "object") return false;
  return (result as { state?: unknown }).state === "committed";
}

export function isHeldSend(result: unknown): result is HeldSendResult {
  if (!result || typeof result !== "object") return false;
  return (result as { state?: unknown }).state === "held";
}

/** The held-send envelope, as the daemon hands it to the CLI. */
export type HeldSendResult = {
  state: "held";
  decision?: "local_hold" | "syncing_hold";
  newMessageCount?: number;
  shownMessageCount?: number;
  omittedMessageCount?: number;
  heldMessages?: AgentMessageRecord[];
  continueAnywaySuggested?: boolean;
  withheldMessageCount?: number;
  continuation?: { id: string; target: string; choices: readonly string[] };
};

const HELD_SEND_NEXT_ACTION =
  "Review the held context, then update the draft or send the current draft unchanged.";

export function heldSendCliError(
  target: string,
  result: HeldSendResult,
  reviewerIsolation: boolean,
): CliError {
  if (reviewerIsolation) {
    const count =
      typeof result.newMessageCount === "number"
        ? result.newMessageCount
        : typeof result.withheldMessageCount === "number"
          ? result.withheldMessageCount
          : 0;
    return new CliError({
      code: "SEND_HELD_AS_DRAFT",
      message: `Reviewer-isolation freshness hold: ${count} newer ${count === 1 ? "message" : "messages"} withheld.`,
      retryable: false,
      effect: "draft_saved",
      draftSaved: true,
      suggestedNextAction: HELD_SEND_NEXT_ACTION,
    });
  }
  return new CliError({
    code: "SEND_HELD_AS_DRAFT",
    message: "Message held as draft; no target delivery occurred.",
    retryable: false,
    effect: "draft_saved",
    draftSaved: true,
    contextText: formatHeldSend(target, result),
    suggestedNextAction: HELD_SEND_NEXT_ACTION,
  });
}
