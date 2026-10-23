import { AppError } from "#src/lib/app-error";
import {
  assertCanManageApps,
  type WorkspaceMemberRole,
} from "#src/server/workspaces/member-role.server";

/** Whether `app-marketplace` is on for a Workspace. */
export type MarketplaceFlag = (workspace: {
  workspaceId: string;
  workspaceSlug: string;
}) => Promise<boolean>;

/** The refusal for a Workspace where `app-marketplace` is off: the feature is not there. */
export const marketplaceOff = () =>
  new AppError("ACCESS_DENIED", { errorId: "app-marketplace-off" });

/**
 * The gate every Marketplace action passes, in this order: the actor is a member of the Workspace
 * the request comes from (ACCESS_DENIED otherwise), holds the app-managing role when `manage`
 * (ACCESS_DENIED), and `app-marketplace` is on there (the off refusal). Returns the Workspace as
 * the flags see it.
 */
export async function requireMarketplaceMember(
  members: {
    findMember(
      workspaceId: string,
      userId: string,
    ): Promise<{ role: WorkspaceMemberRole; workspaceSlug: string } | undefined>;
  },
  enabled: MarketplaceFlag,
  actor: { workspaceId: string; actorUserId: string },
  { manage }: { manage: boolean },
) {
  const member = await members.findMember(actor.workspaceId, actor.actorUserId);
  if (!member) throw new AppError("ACCESS_DENIED");
  if (manage) assertCanManageApps(member.role);
  const workspace = { workspaceId: actor.workspaceId, workspaceSlug: member.workspaceSlug };
  if (!(await enabled(workspace))) throw marketplaceOff();
  return workspace;
}
