import {
  MESSAGE_ANCHOR_SOURCE,
  UUID_LIKE_SOURCE,
  type AgentMessageValidationMessage,
} from "@lrm/coforge-sdk/internal";
import { AgentMessageValidationError } from "#src/server/conversations/agent-message-validation-error.server";

/** The message-id short forms (eight hex, dashed twelve hex) or a full UUID; both address a
 * Message. */
export const MESSAGE_ANCHOR = new RegExp(`^(?:${MESSAGE_ANCHOR_SOURCE}|${UUID_LIKE_SOURCE})$`);

export function assertMessageAnchor(anchor: string) {
  if (!MESSAGE_ANCHOR.test(anchor))
    throw new AgentMessageValidationError(
      "message anchor must be eight hexadecimal characters or a full UUID",
    );
}

/** The single row an anchor lookup (`take: 2`) found; `notFound` is the miss message. */
export function onlyAnchorMatch<T>(rows: T[], notFound: AgentMessageValidationMessage): T {
  if (rows.length > 1)
    throw new AgentMessageValidationError("ambiguous message prefix; use the full UUID");
  const row = rows[0];
  if (!row) throw new AgentMessageValidationError(notFound);
  return row;
}
