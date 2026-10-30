import type { AgentMessageRecord, AgentMessageResponse } from "@lrm/coforge-sdk/internal";
import { invalidArgument } from "./command-help";
import { CliError, withOutputMode } from "./cli-error";
import { readPipedSendContent, refuseForeignStdinFile } from "./send-stdin";
import {
  heldSendCliError,
  isCommittedSend,
  isHeldSend,
  type HeldSendResult,
} from "./send-held-result";
import { formatSendCommitted, formatSendSuccess } from "./message-format";
import { undeliveredMentionError } from "./send-undelivered";
import type { PendingMentionAction } from "./message-format";

/** The `message continue` answer's result: a send outcome plus the resolved continuation's
 * facts. `state`/`continuation` re-`held` on a re-hold, `clearedDraft` ends choice `c`, and
 * `replayedOriginal` says the key's earlier commit delivered instead of this body. */
type ContinuedSendResult = Omit<HeldSendResult, "state"> & {
  state?: "sent" | "held" | "committed";
  messageId?: string;
  idempotencyKey?: string;
  continuationTarget?: string;
  clearedDraft?: boolean;
  replayedOriginal?: boolean;
  recentUnread?: AgentMessageRecord[];
  joinedChannel?: string;
  pendingMentionActions?: PendingMentionAction[];
  unresolvedMentionHandles?: string[];
};

/** `coforge message continue <continuation-id> <a|b|c|d>`: the held send's answer; `b` reads its
 * replacement body from stdin at run time. */
export function parseMessageContinueArgs(args: readonly string[]): {
  continuationId: string;
  continuationChoice: "a" | "b" | "c" | "d";
  json?: boolean;
} {
  const continuationId = args[2];
  const choice = args[3];
  let json = false;
  for (let index = 4; index < args.length; index++) {
    if (args[index] === "--json") json = true;
    else throw invalidArgument("message continue", `Unknown argument "${args[index] ?? ""}".`);
  }
  if (!continuationId) throw invalidArgument("message continue", "a continuation id is required.");
  if (choice !== "a" && choice !== "b" && choice !== "c" && choice !== "d")
    throw invalidArgument("message continue", "choice must be one of a, b, c, d.");
  return {
    continuationId,
    continuationChoice: choice,
    ...(json ? { json: true as const } : {}),
  };
}

/** `message continue`'s dispatch: `b`'s stdin body, then the outcome's rendering — a discard
 * line for `c`, the never-a-success replay report, a re-held notice, or the ordinary send
 * success. */
export async function runMessageContinue(
  invocation: {
    continuationId: string;
    continuationChoice: "a" | "b" | "c" | "d";
    json?: boolean;
  },
  transport: (
    continuationId: string,
    choice: "a" | "b" | "c" | "d",
    body?: string,
  ) => Promise<unknown>,
): Promise<unknown> {
  const outputMode = invocation.json ? "json" : "text";
  const choice = invocation.continuationChoice;
  if (choice !== "b")
    refuseForeignStdinFile(
      [
        `coforge message continue ${invocation.continuationId} b <<'COFORGE_MESSAGE'`,
        "replacement message body",
        "COFORGE_MESSAGE",
      ],
      { draftSaved: false, outputMode },
    );
  // `b`'s replacement body is the piped stdin; every other choice carries no body.
  const body = choice === "b" ? await readPipedSendContent() : undefined;
  const result = (await transport(invocation.continuationId, choice, body)) as ContinuedSendResult;
  const target = result.continuationTarget ?? result.continuation?.target ?? "";
  if (result.clearedDraft) {
    if (invocation.json)
      return JSON.stringify({
        state: "cleared",
        continuationId: invocation.continuationId,
        target,
      });
    return `Draft for ${target} discarded; nothing was sent.`;
  }
  if (isHeldSend(result))
    throw withOutputMode(heldSendCliError(target, result as HeldSendResult, false), outputMode);
  if (isCommittedSend(result))
    return invocation.json
      ? JSON.stringify({
          state: "committed",
          target,
          messageId: result.messageId,
          idempotencyKey: result.idempotencyKey,
          reconciliation: true,
          receiptComplete: false,
        })
      : formatSendCommitted(target, result.messageId);
  if (result.replayedOriginal) {
    // The send's key was already committed: `messageId` is the ORIGINAL message. For `b` that
    // means the replacement content was never delivered — not the success of the rewrite.
    if (invocation.json)
      return JSON.stringify({
        state: "replayed_original",
        target,
        messageId: result.messageId,
        continuationId: invocation.continuationId,
      });
    return choice === "b"
      ? `Already sent — the original message was delivered as ${result.messageId}; the replacement content was NOT sent.`
      : `Already sent — the message was already delivered as ${result.messageId}.`;
  }
  const sent = result as {
    messageId?: string;
    recentUnread?: AgentMessageRecord[];
    pendingMentionActions?: PendingMentionAction[];
    unresolvedMentionHandles?: string[];
    joinedChannel?: string;
  };
  const undelivered = undeliveredMentionError(target, sent, outputMode);
  if (invocation.json) {
    if (undelivered) throw undelivered;
    return JSON.stringify({
      state: "sent",
      target,
      messageId: sent.messageId,
      recentUnread: sent.recentUnread ?? [],
      ...(sent.joinedChannel ? { joinedChannel: sent.joinedChannel } : {}),
    });
  }
  if (undelivered) throw undelivered;
  return formatSendSuccess(target, sent, sent.recentUnread);
}
