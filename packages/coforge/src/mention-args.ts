import { MESSAGE_ANCHOR_SOURCE, UUID_LIKE_SOURCE } from "@lrm/coforge-sdk/internal";
import { CliError } from "#src/cli-error";
import { MENTION_DELIVERY_MESSAGE_ID_HINT } from "#src/mention-format";
import { parseMentionPendingArgs } from "#src/mention-pending";
import { unknownCommandError } from "./command-help";
import type { MentionInvocation } from "../index";

const MENTION_USAGE =
  "Usage: coforge mention pending [--limit <n>] [--json] | coforge mention notify <resolution-id>... [--json] | coforge mention add <resolution-id>... [--json] | coforge mention delivery --message <message-id> [--json]";

/** The message-id short forms (twelve hex, dashed, or eight hex) or a full UUID; the server stores
 * ids lowercase. */
const MESSAGE_ANCHOR_PATTERN = new RegExp(
  `^(?:${MESSAGE_ANCHOR_SOURCE}|${UUID_LIKE_SOURCE})$`,
  "i",
);

export function parseMentionArgs(args: readonly string[]): MentionInvocation {
  const [sub, ...rest] = args;
  if (sub === "delivery") return parseMentionDeliveryArgs(rest);
  if (sub === "pending") return parseMentionPendingArgs(rest);
  const json = rest.includes("--json");
  const positionals = rest.filter((arg) => arg !== "--json");
  if (positionals.some((arg) => arg.startsWith("--"))) throw new Error(MENTION_USAGE);
  if (sub === "notify" || sub === "add") {
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

/** `coforge mention delivery --message <id> [--json]`: the message by its full id or the
 * eight-hex prefix `message read` shows, as `message resolve` and `message react` take it. */
function parseMentionDeliveryArgs(args: readonly string[]): MentionInvocation {
  const json = args.includes("--json");
  const outputMode = json ? "json" : "text";
  let messageId: string | undefined;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--json") continue;
    if (args[index] === "--message" && args[index + 1] !== undefined)
      messageId = args[++index]!.trim();
    else throw new Error(MENTION_USAGE);
  }
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
