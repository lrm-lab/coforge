import { Prisma, type PrismaClient } from "#src/generated/prisma/client";
import { searchTerms } from "#src/lib/search-terms";
import { readableChannelSql } from "#src/server/conversations/channel-read-access.server";
import { containsPattern } from "#src/server/db/repositories/message-search.repositories.server";
import { requireWorkspaceMember } from "#src/server/workspaces/workspace-membership.server";

const TASK_SEARCH_LIMIT = 5;

export type TaskSearchInput = {
  workspaceId: string;
  userId: string;
  query: string;
  /** Only Tasks in this conversation. */
  conversationId?: string;
  /** The conversation the viewer is in: its Tasks rank first. */
  currentConversationId?: string;
};

/**
 * What the words select. A number is unique only inside its conversation, so `#46` is every
 * conversation's 46, and `#general:#46` the one in that channel; anything else matches the title.
 */
function taskMatch(query: string): Prisma.Sql[] {
  const reference = /^#([^\s:#]+):#(\d+)$/.exec(query);
  if (reference)
    return [
      Prisma.sql`c."channelName" = ${reference[1]}`,
      Prisma.sql`t."number" = ${Number(reference[2])}`,
    ];
  const number = /^#(\d+)$/.exec(query);
  if (number) return [Prisma.sql`t."number" = ${Number(number[1])}`];
  return searchTerms(query).map((term) => Prisma.sql`t."title" ILIKE ${containsPattern(term)}`);
}

/** The Tasks a search finds, in the conversations the viewer may read, newest change first. */
export async function searchTasks(db: PrismaClient, input: TaskSearchInput) {
  await requireWorkspaceMember(db, input.workspaceId, input.userId);
  const match = taskMatch(input.query);
  if (match.length === 0) return [];
  const conditions = [
    Prisma.sql`t."workspaceId" = ${input.workspaceId}::uuid`,
    Prisma.sql`(${readableChannelSql("c", input.workspaceId, { userId: input.userId })}
      OR c."directKey" IS NOT NULL AND EXISTS (
      SELECT 1 FROM "conversation_members" v
      WHERE v."conversationId" = c."id" AND v."userId" = ${input.userId}::uuid))`,
    ...match,
    ...(input.conversationId
      ? [Prisma.sql`t."conversationId" = ${input.conversationId}::uuid`]
      : []),
  ];
  const current = input.currentConversationId
    ? Prisma.sql`t."conversationId" = ${input.currentConversationId}::uuid DESC,`
    : Prisma.empty;
  const rows = await db.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT t."id" FROM "tasks" t
    JOIN "conversations" c ON c."id" = t."conversationId"
    WHERE ${Prisma.join(conditions, " AND ")}
    ORDER BY ${current} t."updatedAt" DESC
    LIMIT ${TASK_SEARCH_LIMIT}`);
  const order = new Map(rows.map((row, index) => [row.id, index]));
  const tasks = await db.task.findMany({
    where: { id: { in: rows.map((row) => row.id) } },
    select: {
      id: true,
      number: true,
      title: true,
      status: true,
      conversation: { select: { id: true, channelName: true } },
    },
  });
  return tasks.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
}
