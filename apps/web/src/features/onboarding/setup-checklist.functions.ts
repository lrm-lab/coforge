import { createServerFn } from "@tanstack/react-start";
import { declareNoStore } from "#src/features/no-store-response.server";
import { workspaceUserMiddleware } from "#src/features/auth/function-auth";
import { configuredGitHub } from "#src/server/integrations/github-config.server";
import { SetupChecklist } from "#src/server/onboarding/setup-checklist.server";

function setupChecklist(db: ConstructorParameters<typeof SetupChecklist>[0]) {
  return new SetupChecklist(db, {
    githubStatus: async (userId) => {
      const github = await configuredGitHub();
      // The stored snapshot only: a live refresh would make the sidebar wait on GitHub.
      return github ? (await github.connection.overview(userId)).status : "unconfigured";
    },
  });
}

/** The viewer's setup steps in the Workspace the page names. */
export const loadSetupChecklist = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .handler(async ({ context }) => {
    declareNoStore();
    return setupChecklist(context.db).read(context.workspaceId, context.user.id);
  });

/** Closes the checklist for the viewer in the Workspace the page names, on every device. */
export const dismissSetupChecklist = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .handler(async ({ context }) => {
    await setupChecklist(context.db).dismiss(context.workspaceId, context.user.id);
  });
