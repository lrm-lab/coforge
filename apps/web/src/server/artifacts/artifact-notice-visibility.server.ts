import { Prisma } from "#src/generated/prisma/client";
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
      OFFSET 0
    )
  )`;
}
