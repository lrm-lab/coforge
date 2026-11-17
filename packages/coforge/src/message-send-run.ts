import { mentionsInContent, type AgentMessageRecord } from "@lrm/coforge-sdk/internal";
import {
  CliError,
  NO_MESSAGE_SENT_NEXT_ACTION,
  unknownDeliveryNextAction,
  withOutputMode,
} from "#src/cli-error";
import {
  convertLongMessageToAttachment,
  formatLongMessageConvertedSuffix,
} from "#src/long-message-attachment";
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
  readBody: () => Promise<string> = readPipedSendContent,
): Promise<unknown> {
  const outputMode = invocation.json ? "json" : "text";
  if (invocation.discardDraft) {
    if (await sendDraftStdinHasContent()) {
      throw withOutputMode(
        new CliError({
          code: "DISCARD_DRAFT_STDIN_UNSUPPORTED",
          message: "--discard-draft clears a saved draft and does not accept stdin.",
          retryable: false,
          draftSaved: false,
          suggestedNextAction: NO_MESSAGE_SENT_NEXT_ACTION,
        }),
        outputMode,
      );
    }
    let discardedResult: {
      discarded?: boolean;
      clearedDraft?: boolean;
      discardedDraftKey?: string;
    };
    try {
      discardedResult = (await transport.send(invocation.target, undefined, {
        discardDraft: true,
        expectedDraftKey: invocation.expectedDraftKey,
      })) as typeof discardedResult;
    } catch (error) {
      throw error instanceof CliError ? withOutputMode(error, outputMode) : error;
    }
    const discarded =
      discardedResult?.discarded !== false && discardedResult?.clearedDraft !== false;
    if (invocation.json) {
      return JSON.stringify({
        state: "discarded",
        target: invocation.target,
        discarded,
        ...(discardedResult?.discardedDraftKey
          ? { idempotencyKey: discardedResult.discardedDraftKey }
          : {}),
      });
    }
    return discarded
      ? `Draft for ${invocation.target} discarded; nothing was sent.`
      : `No saved draft for ${invocation.target}; nothing was sent.`;
  }
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
  const body = invocation.sendDraft ? undefined : await readBody();
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
  const converted =
    body !== undefined
      ? await convertLongMessageToAttachment({
          body,
          target: invocation.target,
          existingAttachmentIds: invocation.attachmentIds,
          upload: transport.upload,
          outputMode,
          draftSaved: false,
          suggestedNextAction: NO_MESSAGE_SENT_NEXT_ACTION,
        })
      : {
          body: undefined,
          attachmentIds: invocation.attachmentIds,
          convertedAttachmentId: undefined,
        };
  let result: unknown;
  try {
    result = await transport.send(invocation.target, converted.body, {
      sendDraft: invocation.sendDraft,
      expectedDraftKey: invocation.expectedDraftKey,
      continueAnyway: invocation.continueAnyway,
      freshnessContextMode: invocation.freshnessContextMode,
      attachmentIds: converted.attachmentIds,
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
          ...(converted.convertedAttachmentId
            ? { convertedToAttachmentId: converted.convertedAttachmentId }
            : {}),
        })
      : `${formatSendCommitted(invocation.target, result.messageId)}${formatLongMessageConvertedSuffix(converted.convertedAttachmentId)}`;
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
      ...(converted.convertedAttachmentId
        ? { convertedToAttachmentId: converted.convertedAttachmentId }
        : {}),
    });
  }
  if (undelivered) throw undelivered;
  return `${formatSendSuccess(invocation.target, sent, sent.recentUnread)}${formatLongMessageConvertedSuffix(converted.convertedAttachmentId)}`;
}
