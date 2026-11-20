import { Prisma, type PrismaClient } from "#src/generated/prisma/client";
import { agentReadableArtifactSql } from "./artifact-visible.server";

export function readableArtifactNoticeSql(
  workspaceId: string,
  agentId: string,
  messageId: Prisma.Sql,
): Prisma.Sql {
  const readable = agentReadableArtifactSql(workspaceId, agentId);
  return Prisma.sql`NOT (
    EXISTS (
      SELECT 1 FROM "system_agent_events" e
      WHERE e."messageId" = ${messageId}
        AND e."source" = 'system.artifacts'
        AND e."externalEventId" LIKE '%:web-draft-review:%'
        AND e."workspaceId" = ${workspaceId}::uuid
        AND e."agentId" = ${agentId}::uuid
        AND NOT EXISTS (
          SELECT 1 FROM "artifacts" a
          WHERE a."id"::text = split_part(e."externalEventId", ':', 1)
            AND a."workspaceId" = ${workspaceId}::uuid
            AND a."deletedAt" IS NULL
            AND ${readable})
    )
  )`;
}

export async function artifactNoticeBlockedMessages(
  db: PrismaClient,
  workspaceId: string,
  agentId: string,
  messageIds: readonly string[],
): Promise<Set<string>> {
  if (messageIds.length === 0) return new Set();
  const rows = await db.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT m."id" FROM "messages" m
    WHERE m."id" IN (${Prisma.join(messageIds)})
      AND NOT ${readableArtifactNoticeSql(workspaceId, agentId, Prisma.sql`m."id"`)}`);
  return new Set(rows.map((row) => row.id));
}
