import type { PrismaClient } from "#src/generated/prisma/client";
import { roleCan } from "#src/features/workspaces/workspace-roles";
import { AppError } from "#src/lib/app-error";
import { workspaceAssistantOnboarding } from "#src/server/agents/workspace-assistant-onboarding.server";
import { workspaceResourceState } from "#src/server/db/repositories/workspace-resource-recovery.repositories.server";
import { ensureWeeklyReportAssistant } from "#src/server/records/weekly-report-assistant.server";
import { provisionWorkspaceEnrollment } from "./enrollment.server";

/** Opening an enrolled Workspace repairs resources whose post-commit provisioning failed. */
export async function recoverWorkspaceResourcesOnOpen(
  db: PrismaClient,
  input: { workspaceId: string; userId: string },
) {
  // Existing onboarding first runs WorkspaceAssistants.ensure (Agent, session and DM),
  // even when Memory provisioning already succeeded, then retries cloud/transport work.
  const session = await workspaceAssistantOnboarding(db).ensure(input.workspaceId, input.userId);
  const state = await workspaceResourceState(db, { ...input, platformAgentId: session.agentId });
  if (!state) throw new AppError("ACCESS_DENIED");
  if (!roleCan(state.role, "recoverWorkspaceResources")) return;
  // Provisioning writes its profile atomically. A retained profile without a link records a
  // previously provisioned identity (including deliberate deletion), never a failed first build.
  if (!state.memoryAgentId && !state.hasMemoryProfile)
    await provisionWorkspaceEnrollment(db, input.workspaceId, input.userId);
  if (!state.weeklyAgentId || (!state.weeklyComputerId && state.platformComputerId))
    await ensureWeeklyReportAssistant(db, {
      ...input,
      ...(state.platformComputerId ? { computerId: state.platformComputerId } : {}),
    });
}
