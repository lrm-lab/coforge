import { createServerFn } from "@tanstack/react-start";

import { workspaceUserMiddleware } from "#src/features/auth/function-auth";
import {
  PrismaWorkspaceMemberPreferencesRepository,
  WorkspaceMemberPreferences,
} from "#src/server/db/repositories/workspace-member-preferences.repositories.server";

/** The signed-in member's settings in their selected Workspace: their panels' tab orders, and
 * whether the first-sign-in setup wizard is still pending, from one read. */
export const loadMemberWorkspaceSettings = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .handler(({ context: { user, db, workspaceId } }) =>
    new WorkspaceMemberPreferences(new PrismaWorkspaceMemberPreferencesRepository(db)).get(
      workspaceId,
      user.id,
    ),
  );
