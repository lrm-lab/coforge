import { Prisma, type PrismaClient } from "#src/generated/prisma/client";
import { agentReadableArtifactSql } from "./artifact-visible.server";

export const WEB_DRAFT_REVIEW_MARKER = "web-draft-review";

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
        AND split_part(e."externalEventId", ':', 2) = ${WEB_DRAFT_REVIEW_MARKER}
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

export async function firstBlockedArtifactNoticeSequence(
  db: PrismaClient,
  workspaceId: string,
  agentId: string,
  conversationId: string,
  upTo: number,
): Promise<number | null> {
  const [row] = await db.$queryRaw<{ sequence: number | null }[]>(Prisma.sql`
    SELECT MIN(m."sequence") AS "sequence" FROM "messages" m
    WHERE m."conversationId" = ${conversationId}::uuid
      AND m."sequence" <= ${upTo}
      AND NOT ${readableArtifactNoticeSql(workspaceId, agentId, Prisma.sql`m."id"`)}`);
  return row?.sequence ?? null;
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
