import type { PrismaClient } from "#src/generated/prisma/client";
import { messageAnchorWhere } from "#src/server/db/message-anchor.server";
import {
  ACTIVE_MEMBER_WHERE,
  DIRECT_CONVERSATION_WHERE,
  VISIBLE_CONVERSATION_WHERE,
} from "#src/server/conversations/active-member.server";
import { ReminderRefusal } from "#src/server/reminders/reminders.server";

/** Resolve a reminder's anchor through its Agent's actual channel or DM authority. */
export async function resolveReminderAnchor(
  db: PrismaClient,
  scope: { workspaceId: string; agentId: string },
  target: string,
  messageId: string,
) {
  const [base, threadPrefix] = target.split(":");
  const conversation = base!.startsWith("#")
    ? await db.conversation.findFirst({
        where: {
          workspaceId: scope.workspaceId,
          channelName: base!.slice(1),
          ...VISIBLE_CONVERSATION_WHERE,
          members: { some: { agentId: scope.agentId, ...ACTIVE_MEMBER_WHERE } },
        },
        select: { id: true },
      })
    : await db.conversation.findFirst({
        where: {
          workspaceId: scope.workspaceId,
          ...DIRECT_CONVERSATION_WHERE,
          AND: [
            { members: { some: { agentId: scope.agentId, ...ACTIVE_MEMBER_WHERE } } },
            {
              members: { some: { user: { username: base!.slice(1) }, ...ACTIVE_MEMBER_WHERE } },
            },
          ],
        },
        select: { id: true },
      });
  if (!conversation)
    throw new ReminderRefusal("ACCESS_DENIED", "reminder target is not authorized");
  let rootId: string | undefined;
  if (threadPrefix) {
    const roots = await db.message.findMany({
      where: {
        conversationId: conversation.id,
        threadRootId: null,
        id: messageAnchorWhere(threadPrefix),
      },
      select: { id: true },
      take: 2,
    });
    if (roots.length !== 1)
      throw new ReminderRefusal("NOT_FOUND", "thread target is missing or ambiguous");
    rootId = roots[0]!.id;
  }
  const candidates = await db.message.findMany({
    where: {
      conversationId: conversation.id,
      id: messageAnchorWhere(messageId),
      ...(rootId ? { OR: [{ id: rootId }, { threadRootId: rootId }] } : { threadRootId: null }),
    },
    select: { id: true },
    take: 2,
  });
  if (candidates.length !== 1)
    throw new ReminderRefusal("NOT_FOUND", "message anchor is missing or ambiguous");
  return { messageId: candidates[0]!.id, target: rootId ? `${base}:${rootId}` : base! };
}
