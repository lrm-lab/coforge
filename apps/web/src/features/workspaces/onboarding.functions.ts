import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { workspaceUserMiddleware } from "#src/features/auth/function-auth";
import { WORKSPACE_ONBOARDING_MODES } from "#src/features/workspaces/onboarding-mode";
import {
  loadWorkspaceOnboarding as readOnboarding,
  saveWorkspaceOnboarding as writeOnboarding,
} from "#src/server/workspaces/workspace-onboarding.server";
import { workspaceMemberRole } from "#src/server/workspaces/workspace-membership.server";

export type {
  WorkspaceOnboardingMode,
  WorkspaceOnboardingSettings,
} from "#src/features/workspaces/onboarding-mode";

const saveOnboardingInputSchema = z.object({
  mode: z.enum(WORKSPACE_ONBOARDING_MODES),
  agentId: z.uuid().nullable(),
  newAgentGreeting: z.boolean(),
});

/** Settings → Members → new-member onboarding; null unless the viewer is an owner or admin. */
export const loadWorkspaceOnboarding = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .handler(async ({ context: { user, db, workspaceId } }) =>
    readOnboarding(db, {
      workspaceId,
      actorRole: await workspaceMemberRole(db, workspaceId, user.id),
    }),
  );

/** Saves who welcomes new members and the new-Agent greeting; owner or admin only. */
export const saveWorkspaceOnboarding = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(saveOnboardingInputSchema)
  .handler(async ({ data, context: { user, db, workspaceId } }) =>
    writeOnboarding(db, {
      workspaceId,
      actorRole: await workspaceMemberRole(db, workspaceId, user.id),
      ...data,
    }),
  );
