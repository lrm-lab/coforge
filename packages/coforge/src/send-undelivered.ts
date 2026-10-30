import { CliError } from "#src/cli-error";
import type { AgentMessageRecord } from "@lrm/coforge-sdk/internal";
import {
  formatSendSuccess,
  formatUndeliveredMentions,
  senderPendingMention,
  senderUnresolvedMention,
  type PendingMentionAction,
} from "#src/message-format";

/**
 * A send whose message was queued but some of whose @mentions reached no one is a partial result:
 * the message must not be sent again, and each mention has its own recovery. In text mode what was
 * achieved goes to stdout (the undelivered mentions, then the queued line) before the error; with
 * `--json` the whole partial result is the error's details.
 */
export function undeliveredMentionError(
  target: string,
  sent: {
    messageId?: string;
    recentUnread?: AgentMessageRecord[];
    pendingMentionActions?: PendingMentionAction[];
    unresolvedMentionHandles?: string[];
  },
  outputMode: "text" | "json",
): CliError | undefined {
  const actions = sent.pendingMentionActions ?? [];
  const unresolved = [...new Set(sent.unresolvedMentionHandles ?? [])];
  const count = actions.length + unresolved.length;
  if (count === 0) return undefined;
  const recoveries = actions.flatMap(
    (action) => senderPendingMention(action).recoveryCommand ?? [],
  );
  return new CliError({
    code: "MENTION_DELIVERY_FAILED",
    message: `Partial result for message ${sent.messageId}: message status=queued; ${count} @mention${count === 1 ? "" : "s"} status=not_queued.`,
    retryable: false,
    // The message is queued, so this is a partial success, not a send failure: exit 0 like
    // Raft, or a script that retries on nonzero re-sends a message already delivered.
    exitCode: 0,
    effect: "message_queued",
    draftSaved: false,
    outputMode,
    stdoutText:
      outputMode === "text"
        ? `${formatUndeliveredMentions(actions, unresolved)}\n\n${formatSendSuccess(target, sent as { messageId: string }, sent.recentUnread, true)}`
        : undefined,
    details: {
      result: {
        ...sent,
        state: "partial",
        message: { status: "queued", id: sent.messageId },
        pendingMentionActions: actions.map(senderPendingMention),
        ...(unresolved.length
          ? { unresolvedMentionWarnings: unresolved.map(senderUnresolvedMention) }
          : {}),
      },
    },
    suggestedNextAction: [
      "The message is already queued.",
      ...(recoveries.length
        ? [
            `Run only the per-token mention ${recoveries.length === 1 ? "recovery" : "recoveries"}: ${recoveries.map((command) => `\`${command}\``).join("; ")}.`,
          ]
        : []),
      ...(unresolved.length
        ? [
            "If an unresolved token was literal prose, wrap it in code; otherwise verify the exact handle and send only a corrected follow-up mention.",
          ]
        : []),
      "Do not resend the queued message.",
    ].join(" "),
  });
}

/**
 * A hold is not a transport failure — the server made a definite decision and the daemon already
 * saved the reply as a local draft — but it is still not delivery, so `message send` reports it as
 * a typed error rather than a quiet success. Reviewer isolation keeps withholding message content;
 * the ordinary case keeps printing the existing rich held-context report (`formatHeldSend`).
 */
