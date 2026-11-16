import { Prisma } from "#src/generated/prisma/client";
import { isWorkspaceAdminRole } from "#src/features/workspaces/workspace-roles";
import { actorConversationHomeSql } from "#src/server/conversations/channel-read-access.server";
import type { ArtifactActor, ArtifactViewer } from "./artifact-access.server";

export const epochTimestamp = (at: Date) =>
  Prisma.sql`(TIMESTAMP 'epoch' + ${at.getTime()}::bigint * INTERVAL '1 millisecond')`;

export function visibleToReaderSql(input: {
  workspaceId: string;
  reader: ArtifactActor;
  viewer: ArtifactViewer;
  conversationId?: string | undefined;
}): Prisma.Sql {
  const { workspaceId, reader, viewer } = input;
  if (input.conversationId)
    return Prisma.sql`a."homeKey" = ${`conversation:${input.conversationId}`}`;
  const home = actorConversationHomeSql("home", workspaceId, reader);
  const homeKeyOfConversation = Prisma.sql`'conversation:' || home."id"::text`;
  return Prisma.sql`(a."access" = 'workspace' OR a."homeKey" = 'workspace'
    OR EXISTS (
      SELECT 1 FROM "conversations" home
      WHERE a."homeKey" = ${homeKeyOfConversation} AND ${home.reads})
    OR (${goneHomeReach(workspaceId, reader, viewer)} AND a."homeKey" LIKE 'conversation:%'
      AND NOT EXISTS (
        SELECT 1 FROM "conversations" home
        WHERE a."homeKey" = ${homeKeyOfConversation} AND ${home.stands})))`;
}

function goneHomeReach(workspaceId: string, reader: ArtifactActor, viewer: ArtifactViewer) {
  if (reader.agentId !== undefined) return Prisma.sql`a."authorAgentId" = ${reader.agentId}::uuid`;
  if (isWorkspaceAdminRole(viewer.role ?? undefined)) return Prisma.sql`TRUE`;
  return Prisma.sql`a."authorAgentId" IN (
    SELECT "id" FROM "agents"
    WHERE "workspaceId" = ${workspaceId}::uuid AND "ownerId" = ${reader.userId}::uuid)`;
}
