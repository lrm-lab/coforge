import type { PrismaClient } from "#src/generated/prisma/client";
import { roleCan } from "#src/features/workspaces/workspace-roles";
import { AppError } from "#src/lib/app-error";
import { WorkspaceAssistants } from "#src/server/agents/workspace-assistants.server";
import { workspaceResourceState } from "#src/server/db/repositories/workspace-resource-recovery.repositories.server";
import { ensureWeeklyReportAssistant } from "#src/server/records/weekly-report-assistant.server";
import { isWeeklyReportsEnabledInValue } from "#src/server/records/weekly-reports-gate.server";
export async function recoverWorkspaceResourcesOnOpen(
  db: PrismaClient,
  input: {
    workspaceId: string;
    userId: string;
  },
) {
  const session = await new WorkspaceAssistants(db).ensure(input.workspaceId, input.userId);
  const state = await workspaceResourceState(db, { ...input, platformAgentId: session.agentId });
  if (!state) throw new AppError("ACCESS_DENIED");
  if (!roleCan(state.role, "recoverWorkspaceResources")) return;
  if (
    isWeeklyReportsEnabledInValue(state.experiments) &&
    (!state.weeklyAgentId || (!state.weeklyComputerId && state.platformComputerId))
  )
    await ensureWeeklyReportAssistant(db, {
      ...input,
      ...(state.platformComputerId ? { computerId: state.platformComputerId } : {}),
    });
}
