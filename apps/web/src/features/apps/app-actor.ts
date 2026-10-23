import type { WorkspaceUserContext } from "#src/features/auth/function-auth";
import type { AppActor } from "#src/server/apps/app-registry.server";

/** The member acting, in the Workspace the page URL names. */
export const actorOf = ({ user, workspaceId }: WorkspaceUserContext): AppActor => ({
  workspaceId,
  actorUserId: user.id,
});
