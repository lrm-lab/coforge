import type { PrismaClient } from "#src/generated/prisma/client";
import { messageAnchorWhere } from "#src/server/db/message-anchor.server";
import { MESSAGE_NOT_VISIBLE } from "#src/server/conversations/agent-message-validation-error.server";
import {
  ACTIVE_MEMBER_WHERE,
  TARGETABLE_CONVERSATION_WHERE,
  VISIBLE_CONVERSATION_WHERE,
} from "#src/server/conversations/active-member.server";
import { assertMessageAnchor, onlyAnchorMatch } from "./direct-conversation-anchor.server";
import { AGENT_MESSAGE_WITH_TARGET_INCLUDE } from "./direct-conversation-agent-message.server";

/** A comment-author seat is only an author FK, never an ordinary message capability. */
export async function findAgentScopedMessage(
  db: PrismaClient,
  workspaceId: string,
  agentId: string,
  anchor: string,
) {
  assertMessageAnchor(anchor);
  const rows = await db.message.findMany({
    where: {
      workspaceId,
      id: messageAnchorWhere(anchor),
      conversation: {
        ...VISIBLE_CONVERSATION_WHERE,
        AND: [TARGETABLE_CONVERSATION_WHERE],
        members: { some: { agentId, ...ACTIVE_MEMBER_WHERE } },
      },
    },
    take: 2,
    include: AGENT_MESSAGE_WITH_TARGET_INCLUDE,
  });
  return onlyAnchorMatch(rows, MESSAGE_NOT_VISIBLE);
}
