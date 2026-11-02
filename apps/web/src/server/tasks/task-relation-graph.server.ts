import { MAX_TASK_TREE_DEPTH, taskNameLabel } from "@lrm/coforge-sdk/internal";
import { AppError } from "#src/lib/app-error";
import type { Transaction } from "./task-board-ports.server";
import { groupBy } from "./task-relations.server";
import { NAMED_CONVERSATION_SELECT, taskName } from "./task-view.server";

/**
 * The reads and walks behind the graph checks of a relation write. A cycle or a deep tree can run
 * through any conversation of the Workspace, so these read every edge of the Workspace (by its
 * `workspaceId` index) and only the ids: a Task is read again only to be named in a refusal.
 */

/** The shortest path from `from` to `to` along `next`, both ends included; null when none. */
export function pathBetween(from: string, to: string, next: (id: string) => Iterable<string>) {
  const via = new Map<string, string | null>([[from, null]]);
  const queue = [from];
  for (let head = 0; head < queue.length; head += 1) {
    const id = queue[head]!;
    if (id === to) {
      const path = [id];
      for (let step = via.get(id); step; step = via.get(step)) path.unshift(step);
      return path;
    }
    for (const following of next(id))
      if (!via.has(following)) {
        via.set(following, id);
        queue.push(following);
      }
  }
  return null;
}

/** Who each Task of the Workspace waits for, by id. */
export async function loadWaitsFor(tx: Transaction, workspaceId: string) {
  const edges = await tx.taskDependency.findMany({
    where: { workspaceId },
    select: { taskId: true, blockedByTaskId: true },
  });
  return new Map(
    [...groupBy(edges, (edge) => edge.taskId)].map(([id, rows]) => [
      id,
      rows.map((row) => row.blockedByTaskId),
    ]),
  );
}

/** The Workspace's parent links: who is under whom, by id. */
export async function loadParentTree(tx: Transaction, workspaceId: string) {
  const links = await tx.taskParent.findMany({
    where: { workspaceId },
    select: { taskId: true, parentTaskId: true },
  });
  return {
    parentOf: new Map(links.map((link) => [link.taskId, link.parentTaskId])),
    childrenOf: new Map(
      [...groupBy(links, (link) => link.parentTaskId)].map(([id, rows]) => [
        id,
        rows.map((row) => row.taskId),
      ]),
    ),
  };
}

/** The levels from the top of the tree down to `id`, `id` counted. */
function levelOf(id: string, parentOf: ReadonlyMap<string, string>) {
  let level = 1;
  for (let up = parentOf.get(id); up && level <= MAX_TASK_TREE_DEPTH + 1; up = parentOf.get(up))
    level += 1;
  return level;
}

/** Refuse a parent that would put a Task, with `below` levels of its own subtasks, too deep. */
export function assertDepth(parentOf: ReadonlyMap<string, string>, parent: string, below = 0) {
  if (levelOf(parent, parentOf) + 1 + below > MAX_TASK_TREE_DEPTH)
    throw new AppError("INVALID_INPUT", {
      errorId: "task_relation_invalid",
      hint: `sub-tasks nest at most ${MAX_TASK_TREE_DEPTH} levels deep`,
    });
}

/**
 * The Tasks `ids` as the conversation `from` names them, for a refusal's text: a Task `from` may
 * not name (a private channel's) is "a task in another channel", never its number or channel.
 * `known` are the labels the actor typed themselves.
 */
export async function describe(
  tx: Transaction,
  from: string,
  ids: readonly string[],
  known: ReadonlyMap<string, string>,
) {
  const rows = await tx.task.findMany({
    where: { id: { in: ids.filter((id) => !known.has(id)) } },
    select: { id: true, number: true, conversation: { select: NAMED_CONVERSATION_SELECT } },
  });
  const labels = new Map(rows.map((row) => [row.id, taskNameLabel(taskName(row, from))]));
  return ids.map((id) => known.get(id) ?? labels.get(id) ?? taskNameLabel({ hidden: true }));
}
