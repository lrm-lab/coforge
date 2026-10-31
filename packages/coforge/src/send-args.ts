import { CliError } from "#src/cli-error";

/** The message body is stdin-only: say so with the command to copy, never a bare `Usage:`. */
const SEND_USAGE =
  "Usage: coforge message send --target <target> [options] < message body on stdin\n" +
  "The message body is read from stdin, never from arguments. Write it with a quoted here-document:\n" +
  "  coforge message send --target '#general' <<'COFORGE_MESSAGE'\n" +
  "  Shipped the fix.\n" +
  "  COFORGE_MESSAGE\n" +
  "Unknown options are refused the same way. A mention that was not delivered still exits 0: do\n" +
  "not resend the message.";

/** Every flag `message send` accepts, before the command validates their combination. */
export type MessageSendFlags = {
  target?: string;
  sendDraft: boolean;
  expectedDraftKey?: string;
  continueAnyway: boolean;
  json: boolean;
  reviewerIsolation: boolean;
  rawAttachmentIds: string[];
  rawMentions: string[];
  targetConfirmed: boolean;
};

/**
 * Parses `message send`'s own flags. A positional argument is the mistake this exists to name:
 * the body only ever arrives on stdin, so anything else is refused with the heredoc to copy.
 */
export function parseMessageSendArgs(
  args: readonly string[],
  reviewerIsolation: boolean,
): MessageSendFlags {
  const flags: MessageSendFlags = {
    sendDraft: false,
    continueAnyway: false,
    json: false,
    reviewerIsolation,
    rawAttachmentIds: [],
    rawMentions: [],
    targetConfirmed: false,
  };
  for (let index = 2; index < args.length; index++) {
    const argument = args[index]!;
    if (argument === "--target" && args[index + 1]) flags.target = args[++index]!;
    else if (argument === "--send-draft") flags.sendDraft = true;
    else if (argument === "--expected-draft-key" && args[index + 1])
      flags.expectedDraftKey = args[++index]!;
    else if (argument === "--anyway") flags.continueAnyway = true;
    else if (argument === "--reviewer-isolation") flags.reviewerIsolation = true;
    else if (argument === "--json") flags.json = true;
    else if (argument === "--target-confirmed") flags.targetConfirmed = true;
    else if (argument === "--attachment-id" && args[index + 1])
      flags.rawAttachmentIds.push(args[++index]!);
    else if (argument === "--mention" && args[index + 1]) flags.rawMentions.push(args[++index]!);
    else throw new CliError({ code: "INVALID_ARG", message: SEND_USAGE, retryable: false });
  }
  return flags;
}
