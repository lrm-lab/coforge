import {
  MENTION_PENDING_MAX_LIMIT,
  type AgentMentionPendingResponse,
} from "@lrm/coforge-sdk/agent";
import { CliError, withOutputMode } from "./cli-error";
import { formatPendingMentionActions } from "./mention-format";

export type MentionPendingInvocation = {
  command: "mention-pending";
  json?: boolean;
  limit?: number;
};

const USAGE = "Usage: coforge mention pending [--limit <n>] [--json]";

function invalidLimit(message: string, json: boolean): CliError {
  return new CliError({
    code: "INVALID_ARG",
    message,
    retryable: false,
    outputMode: json ? "json" : "text",
  });
}

/** `mention pending [--limit <n>] [--json]`: `--limit` is a whole number from 1 to the server's
 * largest page. */
export function parseMentionPendingArgs(args: readonly string[]): MentionPendingInvocation {
  let json = false;
  let rawLimit: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--json") json = true;
    else if (args[index] === "--limit" && rawLimit === undefined && args[index + 1] !== undefined)
      rawLimit = args[++index];
    else throw new Error(USAGE);
  }
  let limit: number | undefined;
  if (rawLimit !== undefined) {
    limit = Number(rawLimit);
    if (!Number.isInteger(limit) || limit <= 0)
      throw invalidLimit(`--limit must be a positive integer; got ${rawLimit}`, json);
    if (limit > MENTION_PENDING_MAX_LIMIT)
      throw invalidLimit(
        `--limit must be at most ${MENTION_PENDING_MAX_LIMIT} (the server returns at most ${MENTION_PENDING_MAX_LIMIT} rows, so a larger value would be reported but not honoured); got ${rawLimit}`,
        json,
      );
  }
  return {
    command: "mention-pending",
    ...(json ? { json: true } : {}),
    ...(limit !== undefined ? { limit } : {}),
  };
}

/** `mention pending`: the page as text, or as `{ ok, pendingMentionActions, truncated, limit }`
 * where `truncated` is `null` when the server did not say whether more exist. */
export async function runMentionPending(
  pending: ((limit?: number) => Promise<AgentMentionPendingResponse>) | undefined,
  { json, limit }: MentionPendingInvocation,
): Promise<unknown> {
  if (!pending) throw new Error("Mention transport is unavailable");
  const result = await pending(limit).catch((error: unknown) => {
    throw error instanceof CliError ? withOutputMode(error, json ? "json" : "text") : error;
  });
  if (json)
    return {
      ok: true,
      pendingMentionActions: result.pendingMentionActions,
      truncated: result.hasMore ?? null,
      limit: limit ?? null,
    };
  return formatPendingMentionActions(result.pendingMentionActions, {
    hasMore: result.hasMore,
    limit,
  });
}
