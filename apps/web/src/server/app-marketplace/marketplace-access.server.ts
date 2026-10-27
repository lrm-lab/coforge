import { AppError } from "#src/lib/app-error";
import {
  assertCanManageApps,
  type WorkspaceMemberRole,
} from "#src/server/workspaces/member-role.server";

/**
 * The gate every Marketplace action passes, in this order: the actor is a member of the Workspace
 * the request comes from (ACCESS_DENIED otherwise), and holds the app-managing role when `manage`
 * (ACCESS_DENIED). Returns the member as the store read it.
 */
export async function requireMarketplaceMember<Member extends { role: WorkspaceMemberRole }>(
  members: { findMember(workspaceId: string, userId: string): Promise<Member | undefined> },
  actor: { workspaceId: string; actorUserId: string },
  { manage }: { manage: boolean },
): Promise<Member> {
  const member = await members.findMember(actor.workspaceId, actor.actorUserId);
  if (!member) throw new AppError("ACCESS_DENIED");
  if (manage) assertCanManageApps(member.role);
  return member;
}
