import type { AgentMessageValidationMessage } from "@lrm/coforge-sdk/internal";

export const MESSAGE_NOT_VISIBLE = "message not found or not visible to this Agent";

/** A validation failure that is safe to return to an authenticated Agent. */
export class AgentMessageValidationError extends Error {
  /** Full ids an ambiguous anchor matched, so the Agent can pick a longer one. */
  readonly candidates?: string[];

  constructor(message: AgentMessageValidationMessage, candidates?: string[]) {
    super(message);
    this.name = "AgentMessageValidationError";
    this.candidates = candidates;
  }
}
