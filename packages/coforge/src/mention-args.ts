import { MESSAGE_ANCHOR_SOURCE, UUID_LIKE_SOURCE } from "@lrm/coforge-sdk/internal";
import { CliError } from "#src/cli-error";
import { MENTION_DELIVERY_MESSAGE_ID_HINT } from "#src/mention-format";
import { parseMentionPendingArgs } from "#src/mention-pending";
import { unknownCommandError } from "./command-help";
import { parseCliFlags } from "./cli-flags";
import type { MentionInvocation } from "../index";

const MENTION_USAGE =
  "Usage: coforge mention pending [--limit <n>] [--json] | coforge mention notify <resolution-id>... [--json] | coforge mention add <resolution-id>... [--json] | coforge mention delivery --message <message-id> [--json]";

const MESSAGE_ANCHOR_PATTERN = new RegExp(
  `^(?:${MESSAGE_ANCHOR_SOURCE}|${UUID_LIKE_SOURCE})$`,
  "i",
);

export function parseMentionArgs(args: readonly string[]): MentionInvocation {
  const [sub, ...rest] = args;
  if (sub === "delivery") return parseMentionDeliveryArgs(rest);
  if (sub === "pending") return parseMentionPendingArgs(rest);
  if (sub === "notify" || sub === "add") {
    const { values, positionals } = parseCliFlags({
      args: rest,
      options: { json: { type: "boolean" } },
      allowPositionals: true,
      onError() {
        throw new Error(MENTION_USAGE);
      },
    });
    const json = values.json === true;
    const resolutionIds = [...new Set(positionals.map((id) => id.trim()).filter(Boolean))];
    if (!resolutionIds.length)
      throw new CliError({
        code: "INVALID_ARG",
        message: "At least one resolution id is required.",
        retryable: false,
        outputMode: json ? "json" : "text",
      });
    return {
      command: "mention-action",
      action: sub,
      resolutionIds,
      ...(json ? { json: true } : {}),
    };
  }
  throw unknownCommandError(["mention", ...args]);
}

function parseMentionDeliveryArgs(args: readonly string[]): MentionInvocation {
  const { values } = parseCliFlags({
    args,
    options: {
      json: { type: "boolean" },
      message: { type: "string" },
    },
    onError() {
      throw new Error(MENTION_USAGE);
    },
  });
  const json = values.json === true;
  const outputMode = json ? "json" : "text";
  const messageId = values.message?.trim();
  if (!messageId)
    throw new CliError({
      code: "INVALID_ARG",
      message: "--message <id> is required.",
      retryable: false,
      suggestedNextAction: MENTION_DELIVERY_MESSAGE_ID_HINT,
      outputMode,
    });
  if (!MESSAGE_ANCHOR_PATTERN.test(messageId))
    throw new CliError({
      code: "INVALID_ARG",
      message: `--message takes a message id (a full UUID or its first eight hex characters), not ${messageId}.`,
      retryable: false,
      suggestedNextAction: MENTION_DELIVERY_MESSAGE_ID_HINT,
      outputMode,
    });
  return { command: "mention-delivery", messageId, ...(json ? { json: true } : {}) };
}
