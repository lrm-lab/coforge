import { mapSendResult } from "#src/server/agents/agent-message-http-response.server";
import { attachmentCommentNotices } from "#src/server/attachments/attachment-comment-notices.server";
import {
  createAgentAttachmentMessages,
  attachmentMessageRefusal,
} from "#src/server/attachments/agent-attachment-messages.server";
import { textResponse } from "#src/server/http/text-response.server";
import { createFileRoute } from "@tanstack/react-router";
import type { PrismaClient } from "#src/generated/prisma/client";
import type { AgentHistoryResponse, AgentMessage, AgentSendResponse } from "@lrm/coforge-sdk/agent";
import {
  UUID_LIKE_PATTERN,
  isChannelMessageTarget,
  isValidMentionSelectorArray,
  isSeenExactSeqs,
  MEMORY_OFFER_REQUIRED_MESSAGE,
} from "@lrm/coforge-sdk/internal";
import { createPrismaMemoryAgentDirectory } from "#src/server/workspace-memory/memory-agent-http.server";
import { explicitMemoryQuestionRequiresOffer } from "#src/server/workspace-memory/explicit-memory-answer";
import { agentAuthMiddleware } from "#src/server/agents/agent-http-middleware.server";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";
import {
  readAgentMessages,
  executeAgentSendMessageWithPolicy,
  reconcileAgentSendMessage,
  type AgentMentionSelector,
  type AgentMessageRepository,
} from "#src/server/agents/agent-messages.server";
import { SendDirectMessage } from "#src/server/conversations/direct-message.server";
import { MentionDeliveryIssuer } from "#src/server/conversations/mention-deliveries.server";
import { PrismaMentionDeliveryRepository } from "#src/server/db/repositories/mention-delivery.repositories.server";
import { getMessageRequestIdempotency } from "#src/server/conversations/redis-message-request-idempotency.server";
import {
  MessageRequestInProgressError,
  type MessageRequestRecords,
} from "#src/server/conversations/message-request-idempotency.server";
import { createCentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import { CentrifugoConversationRealtime } from "#src/server/conversations/conversation-realtime.server";
import { bestEffortMessageNotifier } from "#src/server/notifications/web-push-composition.server";
import { isAppErrorCode } from "#src/lib/app-error";
import { AgentSendRejectedError } from "#src/server/conversations/agent-send-rejected-error.server";
import { AGENT_DM_LIMIT_REASON } from "#src/server/conversations/agent-dm-limits.server";
import {
  ambiguousTargetResponse,
  postingTargetRefusalResponse,
} from "#src/server/agents/agent-target-status.server";
import { applyIncomingWeeklyReportBodyEdit } from "#src/server/records/weekly-report-body-restore.server";
import { errorResponse } from "#src/server/agents/agent-http-error.server";
import {
  agentIdempotencyKeyFromQuery,
  readAgentJsonBody,
} from "#src/server/agents/agent-http-routes.server";

export type AgentMessagesGetPrincipal = { workspaceId: string; agentId: string };

/** Parses a sequence-window query param, throwing on a non-integer value. */
function parseSequenceParam(
  query: URLSearchParams,
  key: "fromSequence" | "throughSequence",
): number | undefined {
  const raw = query.get(key);
  if (raw === null) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value)) throw new Error(`invalid ${key}`);
  return value;
}

/** Read-only history route; `query` belongs to the dedicated search route. */
export async function handleAgentMessagesGet(
  request: Request,
  principal: AgentMessagesGetPrincipal,
  repository: AgentMessageRepository,
  attachmentMessages?: ReturnType<typeof createAgentAttachmentMessages>,
): Promise<Response> {
  const query = new URL(request.url).searchParams;
  const idempotencyKey = agentIdempotencyKeyFromQuery(request);
  const scope = { workspaceId: principal.workspaceId, agentId: principal.agentId };
  try {
    if (query.has("query"))
      return Response.json(
        { error: "use /api/agent/v1/messages/search for query" },
        { status: 400 },
      );
    const target = query.get("target");
    if (!target) return Response.json({ error: "target is required" }, { status: 400 });
    const fromSequence = parseSequenceParam(query, "fromSequence");
    const throughSequence = parseSequenceParam(query, "throughSequence");
    const before = query.get("before") ?? undefined;
    const after = query.get("after") ?? undefined;
    const around = query.get("around") ?? undefined;
    const unread = query.get("unread") === "true";
    if (unread && (before || after || around || fromSequence !== undefined))
      return Response.json(
        { error: "unread cannot be combined with before, after, around or fromSequence" },
        { status: 400 },
      );
    // A window start is a read from a sequence, an anchor a read around a message: together they
    // would page across a range the anchor alone does not describe.
    if (fromSequence !== undefined && (before || after || around))
      return Response.json(
        { error: "fromSequence cannot be combined with before, after or around" },
        { status: 400 },
      );
    const page = {
      before,
      after,
      around,
      limit: query.has("limit") ? Number(query.get("limit")) : undefined,
      fromSequence,
      throughSequence,
      ...(unread ? { unread } : {}),
    };
    const result =
      target.startsWith("attachment:") && attachmentMessages
        ? await attachmentMessages.read(scope, target, page)
        : await readAgentMessages(repository, scope, target, page);
    const messages = result.messages as AgentMessage[];
    const response: AgentHistoryResponse = {
      idempotencyKey,
      messages,
      hasOlder: result.hasOlder,
      hasNewer: result.hasNewer,
      olderCursor: messages[0]?.id,
      newerCursor: messages.at(-1)?.id,
      modelSeenUpToSeq: result.modelSeenUpToSeq,
      unreadCursorBefore: result.unreadCursorBefore,
      readPositionAfter: result.readPositionAfter,
      moreUnread: result.moreUnread,
      ...(result.consumptionScope ? { consumptionScope: result.consumptionScope } : {}),
    };
    return Response.json(response);
  } catch (error) {
    const target = new URL(request.url).searchParams.get("target") ?? "";
    return (
      (target.startsWith("attachment:") ? attachmentMessageRefusal(error) : undefined) ??
      ambiguousTargetResponse(error, target) ??
      Response.json({ error: "invalid message query" }, { status: 400 })
    );
  }
}

const UUID_PATTERN = UUID_LIKE_PATTERN;
const ATTACHMENT_IDS_MAX_LENGTH = 10;

/** Shape-only validation for `attachmentIds`: an array of at most 10 unique UUIDs. Deeper
 * per-id ownership/existence checks happen in the repository's own send transaction. */
function isValidAttachmentIdsArray(value: unknown): value is string[] {
  if (!Array.isArray(value) || value.length > ATTACHMENT_IDS_MAX_LENGTH) return false;
  if (!value.every((id) => typeof id === "string" && UUID_PATTERN.test(id))) return false;
  return new Set(value).size === value.length;
}

export type AgentMessagesPostPrincipal = { workspaceId: string; agentId: string };

/** The in-flight duplicate: this key's first request is still working. */
const inProgress = (error: MessageRequestInProgressError) =>
  errorResponse("MESSAGE_REQUEST_IN_PROGRESS", error.message, 409, true);

/**
 * The `reconcileOnly` send: whether this key already committed, answered from the request record
 * alone. It needs only the target and the key, and never sends or holds.
 */
async function handleAgentSendReconciliation(
  body: Record<string, unknown>,
  principal: AgentMessagesPostPrincipal,
  requestRecords: MessageRequestRecords,
): Promise<Response> {
  // The key alone identifies the send's record, but the `reconcileOnly` contract carries the
  // target too, so a request without one is malformed.
  if (
    typeof body.target !== "string" ||
    !body.target ||
    typeof body.idempotencyKey !== "string" ||
    !body.idempotencyKey
  )
    return Response.json(
      { error: "reconcileOnly needs target and idempotencyKey" },
      { status: 400 },
    );
  const idempotencyKey = body.idempotencyKey;
  try {
    const reconciliation = await reconcileAgentSendMessage(requestRecords, {
      idempotencyKey,
      workspaceId: principal.workspaceId,
      agentId: principal.agentId,
    });
    const response: AgentSendResponse =
      reconciliation.state === "committed"
        ? {
            idempotencyKey,
            state: "committed",
            reconciliation: true,
            receiptComplete: false,
            messageId: reconciliation.messageId,
          }
        : { idempotencyKey, state: "not_found", reconciliation: true };
    return Response.json(response);
  } catch (error) {
    if (error instanceof MessageRequestInProgressError) return inProgress(error);
    throw error;
  }
}

/** Send-route body handling; extracted from the route so it can be tested with fakes. */
export async function handleAgentMessagesPost(
  request: Request,
  principal: AgentMessagesPostPrincipal,
  dependencies: Parameters<typeof executeAgentSendMessageWithPolicy>[0] & {
    requestRecords: MessageRequestRecords;
    attachmentMessages?: ReturnType<typeof createAgentAttachmentMessages>;
    memoryOfferRequired?: (input: {
      workspaceId: string;
      agentId: string;
      target: string;
    }) => Promise<boolean>;
    /** After a stored agent message: weekly-report body edits write the report. */
    onMessageSent?: (input: { messageId: string; target: string; body: string }) => Promise<void>;
  },
): Promise<Response> {
  const body = await readAgentJsonBody(request);
  if (body && typeof body === "object") {
    if (body.reconcileOnly !== undefined && typeof body.reconcileOnly !== "boolean")
      return Response.json({ error: "invalid reconcileOnly" }, { status: 400 });
    if (body.reconcileOnly === true)
      return handleAgentSendReconciliation(body, principal, dependencies.requestRecords);
  }
  if (
    !body ||
    typeof body !== "object" ||
    typeof body.target !== "string" ||
    typeof body.content !== "string"
  )
    return Response.json({ error: "target and content are required" }, { status: 400 });
  const freshnessContextMode = body.freshnessContextMode;
  if (
    freshnessContextMode !== undefined &&
    freshnessContextMode !== "inline" &&
    freshnessContextMode !== "withheld"
  )
    return Response.json({ error: "invalid freshnessContextMode" }, { status: 400 });
  if (body.attachmentIds !== undefined && !isValidAttachmentIdsArray(body.attachmentIds))
    return Response.json({ error: "invalid attachmentIds" }, { status: 400 });
  if (body.mentions !== undefined && !isValidMentionSelectorArray(body.mentions))
    return Response.json({ error: "invalid mentions" }, { status: 400 });
  if (body.seenExactSeqs !== undefined && !isSeenExactSeqs(body.seenExactSeqs))
    return Response.json({ error: "invalid seenExactSeqs" }, { status: 400 });
  // `idempotencyKey` is this request's idempotency key (task #58 ④), and our only one: a request
  // must not be deduplicable under two spellings, so `requestId` is not read. A
  // declared-but-unused `continue` field needs no handling here — this handler only reads what it
  // acts on (the force-send flag is `continueAnyway`).
  const idempotencyKey =
    typeof body.idempotencyKey === "string" && body.idempotencyKey
      ? body.idempotencyKey
      : crypto.randomUUID();
  // An explicit @memory question must be answered with a Memory Offer, not a plain channel send.
  const channelTarget = body.target.split(":")[0] ?? body.target;
  if (dependencies.memoryOfferRequired && isChannelMessageTarget(channelTarget)) {
    const offerRequired = await dependencies.memoryOfferRequired({
      workspaceId: principal.workspaceId,
      agentId: principal.agentId,
      target: channelTarget,
    });
    if (offerRequired) return textResponse(MEMORY_OFFER_REQUIRED_MESSAGE, { status: 400 });
  }
  try {
    const attachment = body.target.startsWith("attachment:")
      ? dependencies.attachmentMessages
      : undefined;
    // Attachment comments have no ordinary delivery/freshness stream. Their authorized
    // history read owns cursor advancement; retain only the shared send receipt protocol.
    const sendDependencies = attachment
      ? { repository: {}, sender: attachment, requestRecords: dependencies.requestRecords }
      : dependencies;
    const result = await executeAgentSendMessageWithPolicy(sendDependencies, {
      idempotencyKey,
      workspaceId: principal.workspaceId,
      agentId: principal.agentId,
      target: body.target,
      content: body.content,
      continueAnyway: body.continueAnyway === true,
      draftReholdCount:
        typeof body.draftReholdCount === "number" && Number.isInteger(body.draftReholdCount)
          ? body.draftReholdCount
          : undefined,
      draftReplacedExisting: body.draftReplacedExisting === true,
      seenUpToSeq:
        !attachment && typeof body.seenUpToSeq === "number" ? body.seenUpToSeq : undefined,
      seenExactSeqs: attachment ? undefined : body.seenExactSeqs,
      freshnessContextMode,
      attachmentIds: Array.isArray(body.attachmentIds)
        ? (body.attachmentIds as string[])
        : undefined,
      mentions: body.mentions as AgentMentionSelector[] | undefined,
    });
    if (result.state === "sent" && result.messageId && dependencies.onMessageSent) {
      try {
        await dependencies.onMessageSent({
          messageId: result.messageId,
          target: body.target,
          body: body.content,
        });
      } catch {
        // The message is already stored. A body-edit that did not write still shows Insert.
      }
    }
    return Response.json(mapSendResult(idempotencyKey, result));
  } catch (error) {
    if (body.target.startsWith("attachment:")) {
      const refusal = attachmentMessageRefusal(error);
      if (refusal) return refusal;
    }
    // The send-specific rejections and the named AppError codes below are mapped here; anything
    // else (e.g. getAgentChannel's ACCESS_DENIED for a non-member) propagates unchanged.
    if (error instanceof AgentSendRejectedError)
      return Response.json({ error: error.message }, { status: error.status });
    // The same key's first request is still working: a duplicate, never a second message. Mapped
    // here because the send keeps its own retryable refusal shape rather than the boundary's
    // generic one.
    if (error instanceof MessageRequestInProgressError) return inProgress(error);
    // An archived channel refuses posting (AppError("CONFLICT") from PublicChannels.send /
    // sendAgentMessage); reported the same way the rest of this route family reports a plain
    // text failure.
    if (isAppErrorCode(error, "CONFLICT"))
      return textResponse("channel is archived", { status: 409 });
    // A private Agent's direct conversation stays scoped to its own creator: a stable
    // code with an explanation, the same rule this route already follows for the other named
    // failures above, rather than a bare 500.
    if (isAppErrorCode(error, "AGENT_DM_RESTRICTED"))
      return errorResponse(
        error.code,
        "this direct message is private and read-only for this Agent",
        403,
        false,
      );
    if (isAppErrorCode(error, "AGENT_DM_CHAIN_LIMIT", "AGENT_DM_RATE_LIMIT"))
      return errorResponse(error.code, AGENT_DM_LIMIT_REASON[error.code], 429, false);
    const refused = postingTargetRefusalResponse(error, body.target);
    if (refused) return refused;
    throw error;
  }
}

/**
 * What one Agent send runs on, built per request. Its repository keeps the channel it resolves, so
 * the Memory Offer check, the freshness check and the send itself look the channel up once.
 */
export function agentMessagesPostDependencies(db: PrismaClient) {
  const repository = new PrismaDirectConversationRepository(db, { oneRequest: true });
  const centrifugo = createCentrifugoServerApi();
  const requestRecords = getMessageRequestIdempotency();
  const directory = createPrismaMemoryAgentDirectory(db);
  return {
    repository,
    requestRecords,
    attachmentMessages: createAgentAttachmentMessages(
      db,
      requestRecords,
      attachmentCommentNotices(db, centrifugo),
    ),
    memoryOfferRequired: async ({
      workspaceId,
      agentId,
      target,
    }: {
      workspaceId: string;
      agentId: string;
      target: string;
    }) => {
      try {
        // The send path's channel: the offer check covers a channel the send would join too.
        const conversation = await repository.getAgentSendChannel(workspaceId, agentId, target);
        return explicitMemoryQuestionRequiresOffer(
          db,
          { workspaceId, agentId, conversationId: conversation.id },
          (currentWorkspaceId, currentAgentId) =>
            directory.isDesignated(currentWorkspaceId, currentAgentId),
        );
      } catch (error) {
        if (isAppErrorCode(error, "ACCESS_DENIED", "INVALID_INPUT")) return false;
        throw error;
      }
    },
    sender: new SendDirectMessage(
      repository,
      requestRecords,
      centrifugo,
      new CentrifugoConversationRealtime(centrifugo),
      bestEffortMessageNotifier(db),
      new MentionDeliveryIssuer(new PrismaMentionDeliveryRepository(db)),
    ),
  };
}

export const Route = createFileRoute("/api/agent/v1/messages")({
  server: {
    middleware: [agentAuthMiddleware],
    handlers: {
      GET: ({ request, context: { principal, db } }) =>
        handleAgentMessagesGet(
          request,
          principal,
          new PrismaDirectConversationRepository(
            db,
            {},
            new CentrifugoConversationRealtime(createCentrifugoServerApi()),
          ),
          createAgentAttachmentMessages(db, getMessageRequestIdempotency()),
        ),
      POST: ({ request, context: { principal, db } }) =>
        handleAgentMessagesPost(request, principal, {
          ...agentMessagesPostDependencies(db),
          onMessageSent: ({ messageId, target, body: messageBody }) =>
            applyIncomingWeeklyReportBodyEdit(db, {
              workspaceId: principal.workspaceId,
              agentId: principal.agentId,
              target,
              messageId,
              body: messageBody,
            }),
        }),
    },
  },
});
