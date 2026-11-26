import { CliError } from "#src/cli-error";
import { parseCliFlags } from "./cli-flags";

const SEND_USAGE =
  "Usage: coforge message send --target <target> [options] < message body on stdin\n" +
  "The message body is read from stdin, never from arguments. Write it with a quoted here-document:\n" +
  "  coforge message send --target '#general' <<'COFORGE_MESSAGE'\n" +
  "  Shipped the fix.\n" +
  "  COFORGE_MESSAGE\n" +
  "Unknown options are refused the same way. A mention that was not delivered still exits 0: do\n" +
  "not resend the message.";

export type MessageSendFlags = {
  target?: string;
  sendDraft: boolean;
  discardDraft: boolean;
  expectedDraftKey?: string;
  continueAnyway: boolean;
  json: boolean;
  reviewerIsolation: boolean;
  rawAttachmentIds: string[];
  rawMentions: string[];
  targetConfirmed: boolean;
};

export function parseMessageSendArgs(
  args: readonly string[],
  reviewerIsolation: boolean,
): MessageSendFlags {
  const { values } = parseCliFlags({
    args: args.slice(2),
    options: {
      target: { type: "string" },
      "send-draft": { type: "boolean" },
      "discard-draft": { type: "boolean" },
      "expected-draft-key": { type: "string" },
      anyway: { type: "boolean" },
      "reviewer-isolation": { type: "boolean" },
      json: { type: "boolean" },
      "target-confirmed": { type: "boolean" },
      "attachment-id": { type: "string", multiple: true },
      mention: { type: "string", multiple: true },
    },
    allowEmptyValues: false,
    onError() {
      throw new CliError({ code: "INVALID_ARG", message: SEND_USAGE, retryable: false });
    },
  });
  return {
    target: values.target,
    sendDraft: values["send-draft"] === true,
    discardDraft: values["discard-draft"] === true,
    expectedDraftKey: values["expected-draft-key"],
    continueAnyway: values.anyway === true,
    json: values.json === true,
    reviewerIsolation: reviewerIsolation || values["reviewer-isolation"] === true,
    rawAttachmentIds: values["attachment-id"] ?? [],
    rawMentions: values.mention ?? [],
    targetConfirmed: values["target-confirmed"] === true,
  };
}
