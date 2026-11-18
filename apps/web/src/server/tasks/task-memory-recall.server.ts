import type { TeamMemoryCommand, TeamMemoryResult } from "@lrm/coforge-sdk/agent";
import type { TaskResult, TaskView } from "@lrm/coforge-sdk/internal";
import type { PrismaClient } from "#src/generated/prisma/client";
import { teamMemory } from "#src/server/team-memory/composition.server";
import type { AgentTaskPrincipal } from "./task-principal.server";

type Search = Extract<TeamMemoryCommand, { operation: "search" }>;
type RecallTask = Pick<TaskView, "title" | "description"> & { project?: { id: string } | null };

export const TASK_MEMORY_RECALL_MS = 400;

export function agentTaskMemoryRecall(db: PrismaClient, principal: AgentTaskPrincipal) {
  if (Bun.env.COFORGE_TEAM_MEMORY_RECALL !== "true") return undefined;
  const memory = teamMemory(db);
  return (task: RecallTask) =>
    recallTaskMemory(task, (search) => memory.execute(principal, search));
}

export async function recallTaskMemory(
  task: RecallTask,
  search: (input: Search) => Promise<TeamMemoryResult>,
  timeoutMs = TASK_MEMORY_RECALL_MS,
): Promise<NonNullable<TaskResult["relatedMemory"]>> {
  const query = [task.title, task.description].filter(Boolean).join(" ").trim().slice(0, 500);
  if (!query) return [];
  let cancel: (() => void) | undefined;
  try {
    const result = await Promise.race([
      search({
        operation: "search",
        query,
        projectId: task.project?.id ?? null,
        includeConflicts: true,
        ...(task.project ? { includeWorkspace: true } : {}),
      }),
      new Promise<undefined>((resolve) => {
        const timer = setTimeout(resolve, timeoutMs);
        cancel = () => clearTimeout(timer);
      }),
    ]);
    return (result?.entries ?? []).slice(0, 5).map((entry) => {
      const conflictsWith = entry.relations
        ?.filter((link) => link.kind === "conflicts_with")
        .map(({ id, revision }) => ({ id, revision }));
      return {
        id: entry.id,
        revision: entry.revision,
        title: entry.title,
        content: entry.content.slice(0, 350),
        source: entry.source.slice(0, 120),
        applicability: entry.applicability.slice(0, 100),
        ...(conflictsWith?.length ? { conflictsWith } : {}),
      };
    });
  } catch {
    return [];
  } finally {
    cancel?.();
  }
}
