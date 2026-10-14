import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import { ACTIVE_MEMBER_WHERE } from "#src/server/conversations/active-member.server";

/**
 * What the project page reads of a Project: its own fields and its channels. `satisfies` makes a
 * field removed from the schema a type error here instead of a failure of every project page at
 * run time. Each channel's activity is read by `readProjectChannelActivity`.
 */
export const PROJECT_DETAIL_SELECT = {
  id: true,
  name: true,
  slug: true,
  description: true,
  iconObjectKey: true,
  githubFullName: true,
  githubHtmlUrl: true,
  commitCoAuthor: true,
  conversations: {
    select: { id: true, channelName: true, createdAt: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  },
} satisfies Prisma.ProjectSelect;

const LAST_MESSAGE_SELECT = {
  createdAt: true,
  sender: {
    select: {
      user: {
        select: { id: true, displayName: true, username: true, avatarObjectKey: true },
      },
      agent: { select: { displayName: true } },
    },
  },
} satisfies Prisma.MessageSelect;

export type ProjectChannelActivity = {
  /** Who is in the channel now: not someone who left it. */
  memberCount: number;
  messageCount: number;
  lastMessage: Prisma.MessageGetPayload<{ select: typeof LAST_MESSAGE_SELECT }> | null;
};

/**
 * Each channel's member count, message count and newest message, read only from those channels.
 *
 * Not as `_count` and a `take: 1` relation on the Project's select: Prisma answers a relation
 * `_count` by grouping the whole related table, every Workspace's messages and members, before
 * joining it to these channels, and a `take: 1` relation over several parents by reading every
 * message of them and keeping the newest in memory. Here the counts group only these channels'
 * rows, and the newest message is one index read per channel.
 */
export async function readProjectChannelActivity(
  db: PrismaClient,
  conversationIds: readonly string[],
): Promise<Map<string, ProjectChannelActivity>> {
  if (conversationIds.length === 0) return new Map();
  const ids = [...conversationIds];
  const [memberCounts, messageCounts, lastMessages] = await Promise.all([
    db.conversationMember.groupBy({
      by: ["conversationId"],
      where: { conversationId: { in: ids }, ...ACTIVE_MEMBER_WHERE },
      _count: { _all: true },
    }),
    db.message.groupBy({
      by: ["conversationId"],
      where: { conversationId: { in: ids } },
      _count: { _all: true },
    }),
    Promise.all(
      ids.map((conversationId) =>
        db.message.findFirst({
          where: { conversationId },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          select: LAST_MESSAGE_SELECT,
        }),
      ),
    ),
  ]);
  const members = new Map(memberCounts.map((row) => [row.conversationId, row._count._all]));
  const messages = new Map(messageCounts.map((row) => [row.conversationId, row._count._all]));
  return new Map(
    ids.map((id, index) => [
      id,
      {
        memberCount: members.get(id) ?? 0,
        messageCount: messages.get(id) ?? 0,
        lastMessage: lastMessages[index] ?? null,
      },
    ]),
  );
}
