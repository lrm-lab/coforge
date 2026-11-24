import type { TeamMemoryCommand, TeamMemoryResult } from "@lrm/coforge-sdk/agent";
import type { TaskResult, TaskView } from "@lrm/coforge-sdk/internal";
import type { PrismaClient } from "#src/generated/prisma/client";
import { teamMemory } from "#src/server/team-memory/composition.server";
import type { AgentTaskPrincipal } from "./task-principal.server";

type Search = Extract<TeamMemoryCommand, { operation: "search" }>;
type RecallTask = Pick<TaskView, "title" | "description"> & { project?: { id: string } | null };
type RecalledMemory = NonNullable<TaskResult["relatedMemory"]>;

export const TASK_MEMORY_RECALL_MS = 400;
const TASK_MEMORY_LIMIT = 5;

function versionKey({ id, revision }: { id: string; revision: number }): string {
  return `${id}:${revision}`;
}

function selectTaskMemory(entries: RecalledMemory): RecalledMemory {
  if (entries.length <= TASK_MEMORY_LIMIT) return entries;
  const selected = new Set<string>();
  for (const entry of entries.slice(0, TASK_MEMORY_LIMIT)) {
    if (!entry.conflictsWith?.length) continue;
    const conflicts = new Set(entry.conflictsWith.map(versionKey));
    const key = versionKey(entry);
    for (const peer of entries) {
      const peerKey = versionKey(peer);
      if (!conflicts.has(peerKey)) continue;
      const additional = Number(!selected.has(key)) + Number(!selected.has(peerKey));
      if (selected.size + additional > TASK_MEMORY_LIMIT) continue;
      selected.add(key);
      selected.add(peerKey);
    }
  }
  for (const entry of entries) {
    if (selected.size >= TASK_MEMORY_LIMIT) break;
    selected.add(versionKey(entry));
  }
  return entries.filter((entry) => selected.has(versionKey(entry)));
}

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
): Promise<RecalledMemory> {
  const query = [task.title, task.description].filter(Boolean).join(" ").trim().slice(0, 500);
  if (!query) return [];
  const startedAt = performance.now();
  let outcome: "hit" | "miss" | "timeout" | "error" = "error";
  let entries: RecalledMemory = [];
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
    if (!result) {
      outcome = "timeout";
      return [];
    }
    if (result.status !== "ok") return [];
    entries = selectTaskMemory(
      result.entries.map((entry) => {
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
      }),
    );
    outcome = entries.length ? "hit" : "miss";
    return entries;
  } catch {
    return [];
  } finally {
    cancel?.();
    console.info(
      JSON.stringify({
        event: "team_memory.task_recall",
        outcome,
        count: entries.length,
        duration_ms: Math.round(performance.now() - startedAt),
      }),
    );
  }
}
