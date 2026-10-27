import type { PrismaClient } from "#src/generated/prisma/client";
import type {
  AgentAttachmentComment,
  AgentAttachmentCommentsRequest,
  AgentAttachmentCommentsResponse,
} from "@lrm/coforge-sdk/agent";
import { workspaceAssistantUser } from "#src/server/agents/workspace-assistant-authority.server";
import { agentMessageView } from "#src/server/conversations/agent-message-view.server";
import { PrismaAttachmentCommentStore } from "#src/server/db/repositories/attachment-comments.repositories.server";
import { AttachmentComments, type AttachmentCommentView } from "./attachment-comments.server";

/** One comment as an Agent reads it: mentions read back as text, reactions as counts. */
function agentComment(comment: AttachmentCommentView): AgentAttachmentComment {
  return {
    id: comment.id,
    sequence: comment.sequence,
    senderKind: comment.senderKind === "user" ? "human" : comment.senderKind,
    senderName: comment.senderName,
    ...(comment.senderHandle ? { senderHandle: comment.senderHandle } : {}),
    body: agentMessageView({ body: comment.body, mentions: comment.mentions }).body,
    createdAt: comment.createdAt,
    reactions: (comment.reactions ?? []).map(({ emoji, count }) => ({ emoji, count })),
    anchor: comment.anchor as AgentAttachmentComment["anchor"],
    resolved: comment.resolved,
  };
}

/**
 * The root comments on an attachment for an Agent: who may read them, and whether they may add
 * one, are `AttachmentComments`' answer alone. A Workspace assistant reads as the person it acts
 * for, as it does for the attachment itself.
 */
export async function readAgentAttachmentComments(
  db: PrismaClient,
  principal: { workspaceId: string; agentId: string },
  { attachmentId, limit, before }: AgentAttachmentCommentsRequest,
): Promise<AgentAttachmentCommentsResponse> {
  const { workspaceId, agentId } = principal;
  const delegate = await workspaceAssistantUser(db, workspaceId, agentId);
  const page = await new AttachmentComments(new PrismaAttachmentCommentStore(db)).list(
    delegate ? { workspaceId, userId: delegate.userId } : { workspaceId, agentId },
    { attachmentId, limit, beforeSequence: before },
  );
  return {
    ok: true,
    attachmentId,
    viewer: {
      canComment: page.canComment,
      canResolve: page.canReact,
      ...(page.canReact
        ? { resolveAction: { type: "reaction" as const, emoji: "✅" as const } }
        : {}),
      ...(page.disabledReason ? { reason: page.disabledReason } : {}),
    },
    comments: page.comments.map(agentComment),
    hasOlder: page.hasOlder,
  };
}
