import { MAX_TASK_TREE_DEPTH, taskNameLabel } from "@lrm/coforge-sdk/internal";
import { AppError } from "#src/lib/app-error";
import type { Transaction } from "./task-board-ports.server";
import { descend, groupBy } from "./task-relations.server";
import { NAMED_CONVERSATION_SELECT, taskName } from "./task-view.server";

/**
 * The reads and walks behind the graph checks of a relation write, and the tree rule those checks
 * end with. A cycle or a deep tree can run through any conversation of the Workspace, so these
 * read every edge of the Workspace (by its `workspaceId` index) and only the ids: a Task is read
 * again only to be named in a refusal.
 */

export const TASK_RELATION_INVALID = "task_relation_invalid";

const invalid = (hint: string) =>
  new AppError("INVALID_INPUT", { errorId: TASK_RELATION_INVALID, hint });

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
export type ParentTree = {
  parentOf: Map<string, string>;
  childrenOf: Map<string, string[]>;
};

export async function loadParentTree(tx: Transaction, workspaceId: string): Promise<ParentTree> {
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

/** The ids above `id` in the tree, nearest first. A malformed stored tree stops at the depth cap. */
export function ancestorsOf(id: string, parentOf: ReadonlyMap<string, string>): Set<string> {
  const ancestors = new Set<string>();
  for (
    let up = parentOf.get(id);
    up && ancestors.size <= MAX_TASK_TREE_DEPTH;
    up = parentOf.get(up)
  )
    ancestors.add(up);
  return ancestors;
}

/** `tree` as a write leaves it when `taskId` joins `parentId` (null detaches), for judging that
 * write against the tree it produces rather than the one it read. */
export function treeWithParent(
  tree: ParentTree,
  taskId: string,
  parentId: string | null,
): ParentTree {
  const parentOf = new Map(tree.parentOf);
  const childrenOf = new Map(
    [...tree.childrenOf].map(([id, children]) => [id, [...children]] as [string, string[]]),
  );
  const previous = parentOf.get(taskId);
  if (previous !== undefined)
    childrenOf.set(
      previous,
      (childrenOf.get(previous) ?? []).filter((child) => child !== taskId),
    );
  if (parentId === null) parentOf.delete(taskId);
  else {
    parentOf.set(taskId, parentId);
    childrenOf.set(parentId, [...(childrenOf.get(parentId) ?? []), taskId]);
  }
  return { parentOf, childrenOf };
}

/** `tree` as a create leaves it when `taskIds` are all made under `parentId`: they are new leaves,
 * so only their parent links (and the parent's children) change. */
export function treeWithChildren(
  tree: ParentTree,
  taskIds: readonly string[],
  parentId: string,
): ParentTree {
  const parentOf = new Map(tree.parentOf);
  const childrenOf = new Map(
    [...tree.childrenOf].map(([id, children]) => [id, [...children]] as [string, string[]]),
  );
  childrenOf.set(parentId, [...(childrenOf.get(parentId) ?? []), ...taskIds]);
  for (const id of taskIds) parentOf.set(id, parentId);
  return { parentOf, childrenOf };
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

export type DependencyEdge = { taskId: string; blockerId: string };

/**
 * Refuse a write that leaves a Task waiting for one of its own ancestors or descendants: the
 * tree's completion order already relates them, so the edge would deadlock. Judged on the tree and
 * dependency edges the write produces, not the ones it read: `added` are the edges it adds, `moved`
 * is the Task whose subtree joins a new parent (whose new ancestor relations can make an existing
 * edge invalid), and `known` labels the ids the actor named.
 */
export async function assertNoTreeDependency(
  tx: Transaction,
  scope: { conversationId: string },
  tree: ParentTree,
  edges: ReadonlyMap<string, readonly string[]>,
  added: readonly DependencyEdge[],
  moved: string | undefined,
  known: ReadonlyMap<string, string>,
) {
  const ancestorCache = new Map<string, Set<string>>();
  const ancestors = (id: string) => {
    let found = ancestorCache.get(id);
    if (!found) ancestorCache.set(id, (found = ancestorsOf(id, tree.parentOf)));
    return found;
  };
  const descendantCache = new Map<string, Set<string>>();
  const descendants = (id: string) => {
    let found = descendantCache.get(id);
    if (!found)
      descendantCache.set(
        id,
        (found = new Set(descend(id, tree.childrenOf, MAX_TASK_TREE_DEPTH).flat())),
      );
    return found;
  };
  const waitsFor = (taskId: string, blockerId: string) =>
    (edges.get(taskId) ?? []).includes(blockerId);
  const refuse = async (waiter: string, blocker: string) => {
    const labels = await describe(tx, scope.conversationId, [waiter, blocker], known);
    throw invalid(
      `${labels[0]!} cannot wait for ${labels[1]!}: it is ${ancestors(waiter).has(blocker) ? "an ancestor" : "a descendant"} in the task tree`,
    );
  };
  for (const edge of added)
    if (ancestors(edge.taskId).has(edge.blockerId) || descendants(edge.taskId).has(edge.blockerId))
      await refuse(edge.taskId, edge.blockerId);
  if (!moved) return;
  // Moving a subtree under a new parent can make an edge between that subtree and one of the new
  // ancestors invalid, in either direction. Edges inside the subtree, and those of tasks outside
  // it, keep the relation they had.
  const above = ancestors(moved);
  for (const taskId of [moved, ...descendants(moved)])
    for (const ancestor of above) {
      if (waitsFor(taskId, ancestor)) await refuse(taskId, ancestor);
      if (waitsFor(ancestor, taskId)) await refuse(ancestor, taskId);
    }
}
