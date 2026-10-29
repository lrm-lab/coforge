import { UUID_LIKE_PATTERN } from "@lrm/coforge-sdk/internal";
import type { PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import type { AgentMessageRepository } from "./agent-messages.server";

/** Comment IDs select their attachment authority, never an ordinary conversation seat. */
export function agentMessageReactionRepository(
  db: PrismaClient,
  ordinary: AgentMessageRepository & {
    setAgentMessageReaction: NonNullable<AgentMessageRepository["setAgentMessageReaction"]>;
  },
): AgentMessageRepository {
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
      // The Web's attachment panel shows no reactions on a comment, so the Agent cannot add one.
      throw new AppError("INVALID_INPUT", { errorId: "attachment-comments-no-reactions" });
    },
  };
}
