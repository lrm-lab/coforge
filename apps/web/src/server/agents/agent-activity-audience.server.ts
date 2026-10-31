import type { PrismaClient } from "#src/generated/prisma/client";
import { CHANNEL_VISIBILITY } from "#src/features/conversations/channel-visibility";
import { ACTIVE_MEMBER_WHERE } from "#src/server/conversations/active-member.server";
import { errorType } from "#src/server/errors/error-type.server";
import { canSeeAgent } from "./agent-visibility.server";

const CHANNEL_PEOPLE_SELECT = {
  channelName: true,
  visibility: true,
  members: {
    where: { userId: { not: null }, ...ACTIVE_MEMBER_WHERE },
    select: { userId: true },
  },
} as const;

/**
 * Who sees an Agent's Activity in one conversation live (task #302). For a private channel, or the
 * Task conversation of a private channel's Task, it is the channel's active people who can see the
 * Agent, each on their own channel (`userConversationChannel`), as a private channel's other
 * changes go (`channelAudience`); for any other conversation `undefined`, and the Agent's Activity
 * channel carries it as before. A read that fails names nobody, so the Activity reaches no one
 * live rather than everyone.
 */
export async function privateActivityAudience(
  db: PrismaClient,
  scope: { workspaceId: string; agentId: string; conversationId: string },
): Promise<readonly string[] | undefined> {
  try {
    const conversation = await db.conversation.findFirst({
      where: { id: scope.conversationId, workspaceId: scope.workspaceId },
      select: {
        ...CHANNEL_PEOPLE_SELECT,
        taskDiscussionOf: { select: { conversation: { select: CHANNEL_PEOPLE_SELECT } } },
      },
    });
    const channel =
      conversation?.channelName === null
        ? conversation.taskDiscussionOf?.conversation
        : conversation;
    if (!channel?.channelName || channel.visibility !== CHANNEL_VISIBILITY.PRIVATE)
      return undefined;
    const userIds = channel.members.flatMap((member) => (member.userId ? [member.userId] : []));
    if (userIds.length === 0) return [];
    const [agent, people] = await Promise.all([
      db.agent.findUnique({
        where: { id: scope.agentId },
        select: { visibility: true, ownerId: true, systemKind: true },
      }),
      db.workspaceMembership.findMany({
        where: { workspaceId: scope.workspaceId, userId: { in: userIds } },
        select: { userId: true, role: true },
      }),
    ]);
    if (!agent) return [];
    return people
      .filter((person) =>
        canSeeAgent({ kind: "user", userId: person.userId, role: person.role }, agent),
      )
      .map((person) => person.userId);
  } catch (error) {
    console.warn(
      JSON.stringify({ event: "activity_audience:read_failed", error_type: errorType(error) }),
    );
    return [];
  }
}
