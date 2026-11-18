import { Prisma } from "#src/generated/prisma/client";
import {
  WORKSPACE_ADMIN_ROLES,
  isWorkspaceAdminRole,
} from "#src/features/workspaces/workspace-roles";
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
  return readableSql(workspaceId, reader, goneHomeReach(workspaceId, reader, viewer));
}

export function visibleToMemberSql(workspaceId: string, userId: string): Prisma.Sql {
  const adminRoles = Prisma.join(WORKSPACE_ADMIN_ROLES);
  return readableSql(
    workspaceId,
    { userId },
    Prisma.sql`(EXISTS (
      SELECT 1 FROM "workspace_memberships" wm
      WHERE wm."workspaceId" = ${workspaceId}::uuid AND wm."userId" = ${userId}::uuid
        AND wm."role" IN (${adminRoles}))
      OR ${ownedAuthorSql(workspaceId, userId)})`,
  );
}

function readableSql(workspaceId: string, reader: ArtifactActor, goneReach: Prisma.Sql) {
  const home = actorConversationHomeSql("home", workspaceId, reader);
  const homeKeyOfConversation = Prisma.sql`'conversation:' || home."id"::text`;
  return Prisma.sql`(a."access" IN ('workspace', 'link') OR a."homeKey" = 'workspace'
    OR EXISTS (
      SELECT 1 FROM "conversations" home
      WHERE a."homeKey" = ${homeKeyOfConversation} AND ${home.reads})
    OR (${goneReach} AND a."homeKey" LIKE 'conversation:%'
      AND NOT EXISTS (
        SELECT 1 FROM "conversations" home
        WHERE a."homeKey" = ${homeKeyOfConversation} AND ${home.stands})))`;
}

const ownedAuthorSql = (workspaceId: string, userId: string) =>
  Prisma.sql`a."authorAgentId" IN (
    SELECT "id" FROM "agents"
    WHERE "workspaceId" = ${workspaceId}::uuid AND "ownerId" = ${userId}::uuid)`;

function goneHomeReach(workspaceId: string, reader: ArtifactActor, viewer: ArtifactViewer) {
  if (reader.agentId !== undefined) return Prisma.sql`a."authorAgentId" = ${reader.agentId}::uuid`;
  if (isWorkspaceAdminRole(viewer.role ?? undefined)) return Prisma.sql`TRUE`;
  return ownedAuthorSql(workspaceId, reader.userId);
}
