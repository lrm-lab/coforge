import type { PrismaClient } from "#src/generated/prisma/client";
import { assertCanDeleteAgents } from "#src/server/workspaces/member-role.server";
import { workspaceMemberRole } from "#src/server/workspaces/workspace-membership.server";
import { agentAvatarUrl } from "./agent-avatar.server";

/**
 * Every archived Agent of the Workspace, newest archive first, for Settings → Workspace profile.
 * Only those who may archive an Agent (owner/admin) see the list, and they may see every Agent, so
 * no visibility filter applies. The Computer is named as the archived profile names it.
 */
export async function listArchivedAgents(
  db: Pick<PrismaClient, "agent" | "workspaceMembership">,
  workspaceId: string,
  userId: string,
) {
  assertCanDeleteAgents(await workspaceMemberRole(db, workspaceId, userId));
  const agents = await db.agent.findMany({
    where: { workspaceId, deletedAt: { not: null } },
    select: {
      id: true,
      name: true,
      displayName: true,
      avatarObjectKey: true,
      deletedAt: true,
      computer: { select: { name: true, displayName: true } },
    },
    orderBy: [{ deletedAt: "desc" }, { name: "asc" }, { id: "asc" }],
  });
  // A weekly-report assistant is never archived, so the stored display name is the one shown.
  return agents.map((agent) => ({
    id: agent.id,
    displayName: agent.displayName.trim() || agent.name,
    avatarUrl: agentAvatarUrl(workspaceId, agent.id, agent.avatarObjectKey),
    archivedAt: agent.deletedAt!,
    computerName: agent.computer
      ? agent.computer.displayName.trim() || agent.computer.name.trim()
      : null,
  }));
}
