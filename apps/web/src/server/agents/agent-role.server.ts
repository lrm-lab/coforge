import type { PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import { assertCanAssignRole } from "#src/server/workspaces/member-role.server";
import { ACTIVE_AGENT_WHERE } from "./active-agent.server";
import { workspaceMemberRole } from "#src/server/workspaces/workspace-membership.server";

export type SetAgentRoleInput = {
  workspaceId: string;
  /** The human performing the change; must be an admin-like Workspace member. */
  actorUserId: string;
  agentId: string;
  /** Never `"owner"`: `assertCanAssignRole` rejects it, as it does for a member. */
  role: string;
};

/**
 * Changes an Agent's own server role (`Agent.role`), one of the two bases
 * `channel-authority.server.ts#resolveChannelAuthority` derives channel-admin authority from.
 * Gated the way giving a Workspace member a role is (`assertCanAssignRole`): the
 * actor must be `owner`/`admin`, and the assigned role itself can only be `admin` or `member`.
 */
export async function setAgentRole(
  db: PrismaClient,
  input: SetAgentRoleInput,
): Promise<{ agentId: string; role: string }> {
  const role = assertCanAssignRole(
    await workspaceMemberRole(db, input.workspaceId, input.actorUserId),
    input.role,
  );
  const agent = await db.agent.findFirst({
    where: { id: input.agentId, workspaceId: input.workspaceId, ...ACTIVE_AGENT_WHERE },
    select: { id: true },
  });
  if (!agent) throw new AppError("NOT_FOUND");
  await db.agent.update({ where: { id: agent.id }, data: { role } });
  return { agentId: agent.id, role };
}
