import type { ActionPrepareInvocation, MessageTransport } from "../index";
import { CliError } from "#src/cli-error";
import {
  ACTION_HEREDOC_DELIMITER,
  parseActionCardInput,
  toActionCardAction,
} from "#src/action-prepare-input";
import { refuseForeignStdinFile } from "#src/send-stdin";

/** What the server answers a posted card with. */
export type ActionPrepareResult = { messageId?: string; metadata?: { kind: string } };

/** `coforge action prepare`: reads the action JSON from stdin, posts the card, says where. */
export async function runActionPrepare(
  transport: MessageTransport,
  invocation: ActionPrepareInvocation,
): Promise<string> {
  if (!transport.actionPrepare) throw new Error("Action transport is unavailable");
  refuseForeignStdinFile([
    `coforge action prepare --target "${invocation.target}" <<'${ACTION_HEREDOC_DELIMITER}'`,
    '{"type":"channel:create","name":"demo","visibility":"public"}',
    ACTION_HEREDOC_DELIMITER,
  ]);
  const raw = await new Response(Bun.stdin.stream()).text();
  const action = toActionCardAction(parseActionCardInput(raw));
  const result = await transport.actionPrepare(invocation.target, action);
  if (!result.messageId)
    throw new CliError({
      code: "INVALID_JSON_RESPONSE",
      message: "Prepare action response did not include a message id",
      retryable: false,
    });
  const shortId = result.messageId.slice(0, 13);
  return `Action card posted to ${invocation.target} as message ${result.messageId} (short ${shortId}). The human can click the action verb to commit.`;
}
