import type { AgentWorkspaceStatisticsStatus } from "@lrm/coforge-sdk/internal";
import type { ComputerAgentWorkspaceScan } from "#src/features/computers/computer.schemas";
import {
  computerWorkspaceScanQuery,
  findOwnedWorkspaceComputer,
} from "./computer-workspace-files.server";

/**
 * One budgeted read of a Computer's Agent workspace directory. Without statistics it lists the
 * directories alone — what the rows and delete need, answered immediately however large the
 * workspaces are. With statistics the Daemon also reports the file counts and sizes it measured
 * within its budgets; a workspace too large to finish reports lower bounds ("truncated") or is
 * left "skipped", and neither case fails the read.
 */
export async function readAgentWorkspaceScan(
  db: Parameters<typeof findOwnedWorkspaceComputer>[0] &
    Parameters<typeof computerWorkspaceScanQuery>[0],
  scope: { userId: string; workspaceId: string; computerId: string },
  withStatistics: boolean,
): Promise<ComputerAgentWorkspaceScan[]> {
  const computer = await findOwnedWorkspaceComputer(db, scope);
  const agents = await db.agent.findMany({
    where: { workspaceId: scope.workspaceId, computerId: computer.id },
    select: { id: true, name: true, displayName: true, deletedAt: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const response = await computerWorkspaceScanQuery(db, computer.id).scan(
    { userId: scope.userId, workspaceId: scope.workspaceId },
    agents.map((agent) => agent.id),
    withStatistics,
  );
  const summaries =
    response.status === "ready"
      ? new Map(response.result.workspaces.map((workspace) => [workspace.agentId, workspace]))
      : new Map();
  const known = agents.map((agent) => {
    const summary = summaries.get(agent.id);
    if (summary) summaries.delete(agent.id);
    const status = summary?.status ?? (response.status === "ready" ? "missing" : "unavailable");
    return {
      agentId: agent.id,
      name: agent.name,
      displayName: agent.displayName,
      state: agent.deletedAt ? ("deleted" as const) : ("active" as const),
      status,
      rootPath: summary?.rootPath ?? "",
      fileCount: summary?.fileCount ?? 0,
      totalSizeBytes: summary?.totalSizeBytes ?? 0,
      modifiedAtMs: summary?.modifiedAtMs ?? 0,
      statisticsStatus: statisticsStatusFor(status, summary, withStatistics),
    };
  });
  const orphaned = [...summaries.values()]
    .sort((a, b) => a.agentId.localeCompare(b.agentId))
    .map((summary) => ({
      agentId: summary.agentId,
      name: summary.agentId,
      displayName: summary.agentId,
      state: "deleted" as const,
      status: summary.status,
      rootPath: summary.rootPath,
      fileCount: summary.fileCount,
      totalSizeBytes: summary.totalSizeBytes,
      modifiedAtMs: summary.modifiedAtMs,
      statisticsStatus: statisticsStatusFor(summary.status, summary, withStatistics),
    }));
  return [...known, ...orphaned];
}

/** Only a directory that exists has measurements to wait for: a listing leaves those pending, and
 * a statistics read reports what the Daemon measured, or "unavailable" when it answered for no
 * such directory or not at all. */
function statisticsStatusFor(
  status: ComputerAgentWorkspaceScan["status"],
  summary: { statisticsStatus: AgentWorkspaceStatisticsStatus | "" } | undefined,
  withStatistics: boolean,
): ComputerAgentWorkspaceScan["statisticsStatus"] {
  if (status !== "present") return "unavailable";
  if (!withStatistics) return "pending";
  return summary?.statisticsStatus || "unavailable";
}
