import type { PrismaClient } from "#src/generated/prisma/client";
import { roleCan } from "#src/features/workspaces/workspace-roles";
import { AppError } from "#src/lib/app-error";
import { WorkspaceAssistants } from "#src/server/agents/workspace-assistants.server";
import { workspaceResourceState } from "#src/server/db/repositories/workspace-resource-recovery.repositories.server";
import { ensureWeeklyReportAssistant } from "#src/server/records/weekly-report-assistant.server";
import { memoryAgentExperimentEnabled } from "#src/server/workspace-memory/memory-agent-gate.server";
import { provisionWorkspaceEnrollment } from "./enrollment.server";

/** Opening an enrolled Workspace repairs resources whose post-commit provisioning failed. */
export async function recoverWorkspaceResourcesOnOpen(
  db: PrismaClient,
  input: { workspaceId: string; userId: string },
) {
  // The session itself is a resource this repairs (Agent, session and DM), but a GET loader
  // never starts the assistant: a missed Start waits for the Daemon's ready recovery, and a
  // computerless assistant for the member's first message.
  const session = await new WorkspaceAssistants(db).ensure(input.workspaceId, input.userId);
  const state = await workspaceResourceState(db, { ...input, platformAgentId: session.agentId });
  if (!state) throw new AppError("ACCESS_DENIED");
  if (!roleCan(state.role, "recoverWorkspaceResources")) return;
  // Provisioning writes its profile atomically. A retained profile without a link records a
  // previously provisioned identity (including deliberate deletion), never a failed first build.
  // A Workspace that never switched the Memory Agent on has none by design (task #6), so its
  // absence is not a failed enrollment: re-provisioning here would write on every page open.
  if (
    !state.memoryAgentId &&
    !state.hasMemoryProfile &&
    (await memoryAgentExperimentEnabled(db, input.workspaceId))
  )
    await provisionWorkspaceEnrollment(db, input.workspaceId, input.userId);
  if (!state.weeklyAgentId || (!state.weeklyComputerId && state.platformComputerId))
    await ensureWeeklyReportAssistant(db, {
      ...input,
      ...(state.platformComputerId ? { computerId: state.platformComputerId } : {}),
    });
}
