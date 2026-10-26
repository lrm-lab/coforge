import { UUID_LIKE_PATTERN } from "@lrm/coforge-sdk/internal";
import type { PrismaClient } from "#src/generated/prisma/client";
import { AttachmentComments } from "#src/server/attachments/attachment-comments.server";
import { PrismaAttachmentCommentStore } from "#src/server/db/repositories/attachment-comments.repositories.server";
import type { AgentMessageRepository } from "./agent-messages.server";
import { workspaceAssistantUser } from "./workspace-assistant-authority.server";

/** Comment IDs select their attachment authority, never an ordinary conversation seat. */
export function agentMessageReactionRepository(
  db: PrismaClient,
  ordinary: AgentMessageRepository & {
    setAgentMessageReaction: NonNullable<AgentMessageRepository["setAgentMessageReaction"]>;
  },
): AgentMessageRepository {
  const comments = new AttachmentComments(new PrismaAttachmentCommentStore(db));
  return {
    setAgentChannelMuted: ordinary.setAgentChannelMuted.bind(ordinary),
    setAgentThreadFollowed: ordinary.setAgentThreadFollowed.bind(ordinary),
    async setAgentMessageReaction(workspaceId, agentId, messageId, emoji, active) {
      // Comment commands print full UUIDs. Unscoped short anchors retain ordinary-message semantics.
      const comment = UUID_LIKE_PATTERN.test(messageId)
        ? await db.attachmentComment.findFirst({
            where: { workspaceId, messageId },
            select: { attachmentId: true, messageId: true },
          })
        : null;
      if (!comment)
        return ordinary.setAgentMessageReaction(workspaceId, agentId, messageId, emoji, active);
      const delegate = await workspaceAssistantUser(db, workspaceId, agentId);
      const actor = delegate ? { workspaceId, userId: delegate.userId } : { workspaceId, agentId };
      // Once classified, refusal must propagate; author/cursor seats cannot authorize a fallback.
      await comments.react(actor, { ...comment, emoji, active });
      return { messageId: comment.messageId };
    },
  };
}
