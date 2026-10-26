import { MESSAGE_ANCHOR_SOURCE, UUID_LIKE_SOURCE } from "@lrm/coforge-sdk/internal";
import type { PrismaClient } from "#src/generated/prisma/client";
import { AppError, isAppError } from "#src/lib/app-error";
import { workspaceAssistantUser } from "#src/server/agents/workspace-assistant-authority.server";
import type {
  readAgentMessages,
  AgentMessagesPage,
} from "#src/server/agents/agent-messages.server";
import type { MessageRequestIdempotency } from "#src/server/conversations/message-request-idempotency.server";
import { PrismaAttachmentCommentStore } from "#src/server/db/repositories/attachment-comments.repositories.server";
import { readAgentMessagePage } from "#src/server/db/repositories/agent-message-history.repositories.server";
import { messageAnchorWhere } from "#src/server/db/message-anchor.server";
import { AttachmentComments } from "./attachment-comments.server";

type Principal = { workspaceId: string; agentId: string };
const TARGET = new RegExp(
  `^attachment:(${UUID_LIKE_SOURCE})(?::(${UUID_LIKE_SOURCE}|${MESSAGE_ANCHOR_SOURCE}))?$`,
  "i",
);
const emptyPage = () => ({
  messages: [],
  hasOlder: false,
  hasNewer: false,
  modelSeenUpToSeq: null,
});

/** A dedicated namespace; a comment conversation never becomes an ordinary Agent target. */
export function createAgentAttachmentMessages(
  db: PrismaClient,
  idempotency: MessageRequestIdempotency,
) {
  const comments = new AttachmentComments(new PrismaAttachmentCommentStore(db));
  async function resolve(principal: Principal, target: string) {
    const parsed = TARGET.exec(target);
    if (!parsed) throw new AppError("INVALID_INPUT");
    const attachmentId = parsed[1]!.toLowerCase();
    const delegate = await workspaceAssistantUser(db, principal.workspaceId, principal.agentId);
    const actor = delegate
      ? { workspaceId: principal.workspaceId, userId: delegate.userId }
      : principal;
    const access = await comments.readAccess(actor, attachmentId);
    const rootId = parsed[2] ? (await anchor(attachmentId, parsed[2], true)).id : null;
    return {
      actor,
      access,
      attachmentId,
      rootId,
      canonicalTarget: `attachment:${attachmentId}${rootId ? `:${rootId}` : ""}`,
    };
  }
  async function anchor(attachmentId: string, value: string, rootOnly = false) {
    const rows = await db.message.findMany({
      where: {
        attachmentComment: { attachmentId },
        id: messageAnchorWhere(value),
        ...(rootOnly ? { threadRootId: null } : {}),
      },
      take: 2,
      select: { id: true, sequence: true, threadRootId: true },
    });
    if (rows.length > 1)
      throw new AppError("INVALID_INPUT", { errorId: "ambiguous-attachment-message" });
    if (!rows[0]) throw new AppError("NOT_FOUND");
    return rows[0];
  }
  return {
    async read(
      principal: Principal,
      target: string,
      page: AgentMessagesPage,
    ): Promise<Awaited<ReturnType<typeof readAgentMessages>>> {
      const { access, attachmentId, rootId, canonicalTarget } = await resolve(principal, target);
      if (!access.conversationId) return emptyPage();
      const conversationId = access.conversationId;
      // A private Agent cursor seat is bookkeeping after source authorization, never authority.
      // Even delegated reads do not consume the human's unread position.
      await db.conversationMember.upsert({
        where: { conversationId_agentId: { conversationId, agentId: principal.agentId } },
        create: { workspaceId: principal.workspaceId, conversationId, agentId: principal.agentId },
        update: {},
      });
      const result = await readAgentMessagePage(db, {
        ...principal,
        conversationId,
        threadRootId: rootId,
        canonicalTarget,
        isChannel: false,
        page,
        additionalScope: { attachmentComment: { attachmentId } },
        resolveAnchor: (value) => anchor(attachmentId, value),
      });
      return {
        ...result,
        messages: result.messages.map((m) => ({ ...m, createdAt: m.createdAt.toISOString() })),
      };
    },
    async executeFromAgent(
      input: Principal & {
        target: string;
        body: string;
        idempotencyKey: string;
        attachmentIds?: string[];
        mentions?: unknown[];
      },
    ) {
      // Reuse the same scoped receipt as ordinary sends, including replay after authority loss.
      return idempotency.execute(
        {
          workspaceId: input.workspaceId,
          senderKind: "agent",
          senderId: input.agentId,
          idempotencyKey: input.idempotencyKey,
        },
        async () => {
          if (input.attachmentIds?.length || input.mentions?.length)
            throw new AppError("INVALID_INPUT", { errorId: "attachment-message-text-only" });
          const { actor, attachmentId, rootId, canonicalTarget } = await resolve(
            input,
            input.target,
          );
          // post re-authorizes in its source/attachment/discussion transaction and validates root ownership.
          const posted = await comments.post(actor, {
            attachmentId,
            body: input.body,
            ...(rootId ? { rootId } : {}),
          });
          return {
            id: posted.id,
            body: posted.body,
            createdAt: new Date(posted.createdAt),
            sequence: posted.sequence,
            attachments: [],
            target: canonicalTarget,
            threadRootId: rootId,
            workspaceId: input.workspaceId,
            agentId: input.agentId,
          };
        },
      );
    },
  };
}

/** Attachment-specific refusals retain the standard Agent API envelope. */
export function attachmentMessageRefusal(error: unknown) {
  if (!isAppError(error)) return undefined;
  const status =
    error.code === "NOT_FOUND"
      ? 404
      : error.code === "ACCESS_DENIED"
        ? 403
        : error.code === "CONFLICT"
          ? 409
          : error.code === "INVALID_INPUT"
            ? 400
            : undefined;
  return status
    ? Response.json(
        {
          error:
            error.errorId === "attachment-message-text-only"
              ? "attachment discussion sends support plain text only; attachments and explicit mentions are unsupported"
              : "attachment message is not available",
          code: error.code,
          retryable: false,
        },
        { status },
      )
    : undefined;
}
