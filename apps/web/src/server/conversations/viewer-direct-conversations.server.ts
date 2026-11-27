import { Prisma } from "#src/generated/prisma/client";
import { ACTIVE_AGENT_WHERE } from "#src/server/agents/active-agent.server";
import { AGENT_VISIBILITY } from "#src/features/agents/agent-visibility";
import { directMessageAgentWhere } from "#src/server/agents/agent-visibility.server";
import {
  WEEKLY_REPORTS_VISIBLE_AGENT_WHERE,
  weeklyReportsVisibleAgentSql,
} from "#src/server/records/weekly-reports-gate.server";

export function viewerDirectConversationWhere(userId: string) {
  return {
    OR: [
      { directKey: { startsWith: "user:", contains: `user:${userId}` } },
      {
        directKey: { endsWith: `|user:${userId}` },
        members: {
          some: {
            agent: {
              AND: [
                directMessageAgentWhere(userId),
                ACTIVE_AGENT_WHERE,
                WEEKLY_REPORTS_VISIBLE_AGENT_WHERE,
              ],
            },
          },
        },
      },
    ],
  } satisfies Prisma.ConversationWhereInput;
}

export function viewerDirectConversationSql(userId: string) {
  return Prisma.sql`(
    (c."directKey" LIKE 'user:%' AND c."directKey" LIKE ${`%user:${userId}%`})
    OR (
      c."directKey" LIKE ${`%|user:${userId}`}
      AND EXISTS (
        SELECT 1 FROM "conversation_members" own
        JOIN "agents" a ON a."id" = own."agentId"
        WHERE own."conversationId" = c."id"
          AND (a."visibility" = ${AGENT_VISIBILITY.PUBLIC} OR a."ownerId" = ${userId}::uuid)
          AND a."deletedAt" IS NULL
          AND ${weeklyReportsVisibleAgentSql(Prisma.raw("a"))}
      )
    )
  )`;
}
