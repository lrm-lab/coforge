import { mentionsInContent, type AgentMessageRecord } from "@lrm/coforge-sdk/internal";
import {
  CliError,
  NO_MESSAGE_SENT_NEXT_ACTION,
  unknownDeliveryNextAction,
  withOutputMode,
} from "#src/cli-error";
import {
  formatSendCommitted,
  formatSendSuccess,
  type PendingMentionAction,
} from "#src/message-format";
import type { MessageTransport } from "#src/message-transport";
import {
  heldSendCliError,
  isCommittedSend,
  isHeldSend,
  type HeldSendResult,
} from "#src/send-held-result";
import {
  readPipedSendContent,
  refuseForeignStdinFile,
  sendDraftStdinHasContent,
} from "#src/send-stdin";
import { undeliveredMentionError } from "#src/send-undelivered";
import type { MessageInvocation } from "../index";

export async function runMessageSend(
  invocation: Extract<MessageInvocation, { command: "send" }>,
  transport: MessageTransport,
): Promise<unknown> {
  const outputMode = invocation.json ? "json" : "text";
  if (invocation.sendDraft && (await sendDraftStdinHasContent())) {
    throw withOutputMode(
      new CliError({
        code: "SEND_DRAFT_STDIN_UNSUPPORTED",
        message: [
          "--send-draft sends the current saved draft and does not accept stdin.",
          "To update the draft, send the revised content normally without --send-draft:",
          `  coforge message send --target "${invocation.target}" <<'COFORGE_MESSAGE'`,
          "  revised message",
          "  COFORGE_MESSAGE",
        ].join("\n"),
        retryable: false,
        draftSaved: false,
        suggestedNextAction: NO_MESSAGE_SENT_NEXT_ACTION,
      }),
      outputMode,
    );
  }
  if (!invocation.sendDraft)
    refuseForeignStdinFile(
      [
        `coforge message send --target "${invocation.target}" <<'COFORGE_MESSAGE'`,
        "reply body",
        "COFORGE_MESSAGE",
      ],
      { draftSaved: false, suggestedNextAction: NO_MESSAGE_SENT_NEXT_ACTION, outputMode },
    );
  const body = invocation.sendDraft ? undefined : await readPipedSendContent();
  // With `--send-draft`, the body (and thus content presence) is only known to the daemon, which
  // already re-sends the draft's own saved mentions when no explicit override is given.
  if (invocation.mentions?.length && body !== undefined) {
    const present = mentionsInContent(body);
    for (const mention of invocation.mentions)
      if (!present.has(mention.name))
        throw withOutputMode(
          new CliError({
            code: "MENTION_NOT_IN_CONTENT",
            message: `Structured mention @${mention.name} is not present in the message body.`,
            retryable: false,
            draftSaved: false,
            suggestedNextAction: NO_MESSAGE_SENT_NEXT_ACTION,
          }),
          outputMode,
        );
  }
  let result: unknown;
  try {
    result = await transport.send(invocation.target, body, {
      sendDraft: invocation.sendDraft,
      expectedDraftKey: invocation.expectedDraftKey,
      continueAnyway: invocation.continueAnyway,
      freshnessContextMode: invocation.freshnessContextMode,
      attachmentIds: invocation.attachmentIds,
      mentions: invocation.mentions,
      targetConfirmed: invocation.targetConfirmed,
    });
  } catch (error) {
    // The transport (`local-client.ts`) already redacts upstream detail for a withheld request;
    // this fallback only covers a transport that throws a bare `Error` without going through it.
    if (invocation.freshnessContextMode === "withheld" && !(error instanceof CliError))
      throw withOutputMode(
        new CliError({
          code: "SEND_FAILED",
          message: "Reviewer-isolation send failed; upstream response detail was withheld.",
          retryable: false,
          draftSaved: true,
          suggestedNextAction: unknownDeliveryNextAction(invocation.target),
        }),
        outputMode,
      );
    throw error instanceof CliError ? withOutputMode(error, outputMode) : error;
  }
  if (isHeldSend(result))
    throw withOutputMode(
      heldSendCliError(
        invocation.target,
        result as HeldSendResult,
        invocation.freshnessContextMode === "withheld",
      ),
      outputMode,
    );
  if (isCommittedSend(result))
    return invocation.json
      ? JSON.stringify({
          state: "committed",
          target: invocation.target,
          messageId: result.messageId,
          idempotencyKey: result.idempotencyKey,
          reconciliation: true,
          receiptComplete: false,
        })
      : formatSendCommitted(invocation.target, result.messageId);
  const sent = result as {
    messageId?: string;
    recentUnread?: AgentMessageRecord[];
    pendingMentionActions?: PendingMentionAction[];
    unresolvedMentionHandles?: string[];
    joinedChannel?: string;
  };
  const undelivered = undeliveredMentionError(invocation.target, sent, outputMode);
  if (invocation.json) {
    if (undelivered) throw undelivered;
    return JSON.stringify({
      state: "sent",
      target: invocation.target,
      messageId: sent.messageId,
      recentUnread: sent.recentUnread ?? [],
      ...(sent.joinedChannel ? { joinedChannel: sent.joinedChannel } : {}),
    });
  }
  if (undelivered) throw undelivered;
  return formatSendSuccess(invocation.target, sent, sent.recentUnread);
}
