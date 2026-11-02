import {
  isBlockerSatisfied,
  MAX_TASK_TREE_DEPTH,
  type TaskLink,
  type TaskName,
  type TaskTreeNode,
  type TaskView,
} from "@lrm/coforge-sdk/internal";
import { Prisma, type PrismaClient } from "#src/generated/prisma/client";
import { BROWSER_MESSAGE_MENTIONS_SELECT } from "#src/server/conversations/mentions.server";
import type { Transaction } from "./task-board-ports.server";
import { taskRelationsEnabled } from "./task-conversations-gate.server";
import {
  emptyRelations,
  FINISHED_TASK_STATUSES,
  NAMED_CONVERSATION_SELECT,
  TASK_MEMBER_SELECT,
  UNFINISHED_TASK_STATUSES,
  taskSelection,
  readTaskText,
  storedTaskStatus,
  taskMember,
  taskName,
  taskView,
  type DiscussionCounts,
  type SelectedTask,
  type TaskReader,
  type TaskRelations,
} from "./task-view.server";

/**
 * The reads behind a Task's blockers, parent and subtasks (`task_dependencies`, `task_parents`):
 * what a `TaskView` adds to its row, read once for a whole page, plus `show`'s dependents and
 * subtree. `taskView` maps the Task row; the rows read here are only other Tasks as a card names
 * them. Whether a Task is blocked is derived here on every read and never stored.
 */

type Client = PrismaClient | Transaction;

/** What a card names another Task by. The message's mentions read a title that was a message. */
const LINK_SELECT = {
  number: true,
  title: true,
  status: true,
  conversation: { select: NAMED_CONVERSATION_SELECT },
  message: { select: { mentions: BROWSER_MESSAGE_MENTIONS_SELECT } },
} satisfies Prisma.TaskSelect;

type LinkRow = Prisma.TaskGetPayload<{ select: typeof LINK_SELECT }>;

const linkTitle = (row: LinkRow, reader: TaskReader) =>
  readTaskText(row.title, reader, row.message?.mentions ?? []);

/** `row` as the card of a Task in the conversation `from` names it; hidden when `from` may not
 * name it (`taskName`). */
function link(row: LinkRow, reader: TaskReader, from: string): TaskLink {
  const status = storedTaskStatus(row.status);
  const name = taskName(row, from);
  return name.hidden
    ? { hidden: true, status }
    : { ...name, title: linkTitle(row, reader), status };
}

/** Names in the order a card lists them: this conversation's first, then by channel, by number;
 * hidden ones last. */
export function byName(a: TaskName, b: TaskName) {
  const key = (name: TaskName) => (name.hidden ? "\uffff" : (name.channel ?? ""));
  const number = (name: TaskName) => (name.hidden ? 0 : name.number);
  return key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : number(a) - number(b);
}

/** The numbers in ascending order, as a new array. */
export const ascending = (numbers: readonly number[]) => numbers.slice().sort((a, b) => a - b);

/** Rows grouped by `key`, each group in the rows' order. */
export function groupBy<Row, Key>(rows: readonly Row[], key: (row: Row) => Key): Map<Key, Row[]> {
  const groups = new Map<Key, Row[]>();
  for (const row of rows) {
    const group = groups.get(key(row));
    if (group) group.push(row);
    else groups.set(key(row), [row]);
  }
  return groups;
}

/**
 * The ids below `rootId`, one array per level, at most `limit` levels. Each id appears once, so a
 * stored cycle cannot loop.
 */
export function descend(
  rootId: string,
  childrenOf: ReadonlyMap<string, readonly string[]>,
  limit = Infinity,
): string[][] {
  const levels: string[][] = [];
  const seen = new Set([rootId]);
  for (let level = [rootId]; level.length && levels.length < limit;) {
    level = level.flatMap((id) => childrenOf.get(id) ?? []).filter((id) => !seen.has(id));
    for (const id of level) seen.add(id);
    if (level.length) levels.push(level);
  }
  return levels;
}

/** Tasks with no unfinished blocker, other than `except` when given. */
export const notBlockedWhere = (except?: string) =>
  ({
    dependencies: {
      none: {
        blocker: {
          status: { in: UNFINISHED_TASK_STATUSES },
          ...(except && { id: { not: except } }),
        },
      },
    },
  }) satisfies Prisma.TaskWhereInput;

export const NOT_BLOCKED_WHERE = notBlockedWhere();

/**
 * The relations of each Task in `ids`: three reads however long the page. A Task with none maps
 * to nothing in the result, which `relationsOf` reads as no relations.
 */
export async function loadTaskRelations(
  db: Client,
  reader: TaskReader,
  all: ReadonlyArray<{ id: string; conversationId: string; workspaceId: string }>,
): Promise<Map<string, TaskRelations>> {
  const relations = new Map<string, TaskRelations>();
  // A Workspace without Tasks v2 reads no relations: its views are as they were before them.
  const on = new Map(
    await Promise.all(
      [...new Set(all.map((task) => task.workspaceId))].map(
        async (workspaceId) => [workspaceId, await taskRelationsEnabled(db, workspaceId)] as const,
      ),
    ),
  );
  const tasks = all.filter((task) => on.get(task.workspaceId));
  if (!tasks.length) return relations;
  const ids = tasks.map((task) => task.id);
  const conversationOf = new Map(tasks.map((task) => [task.id, task.conversationId]));
  const [dependencies, parents, subtasks] = await Promise.all([
    db.taskDependency.findMany({
      where: { taskId: { in: ids } },
      select: { taskId: true, blocker: { select: LINK_SELECT } },
    }),
    db.taskParent.findMany({
      where: { taskId: { in: ids } },
      select: { taskId: true, parent: { select: LINK_SELECT } },
    }),
    // Counted in the database: a parent's children are not read to be counted.
    db.$queryRaw<{ id: string; total: bigint; finished: bigint }[]>`
      SELECT p."parentTaskId"::text AS id, COUNT(*) AS total,
             COUNT(*) FILTER (WHERE t."status" IN (${Prisma.join(FINISHED_TASK_STATUSES)})) AS finished
      FROM "task_parents" p JOIN "tasks" t ON t."id" = p."taskId"
      WHERE p."parentTaskId" = ANY(${ids}::uuid[])
      GROUP BY p."parentTaskId"`,
  ]);
  const entry = (id: string) => {
    let current = relations.get(id);
    if (!current) relations.set(id, (current = emptyRelations()));
    return current;
  };
  for (const row of dependencies) {
    const current = entry(row.taskId);
    current.blockedBy.push(link(row.blocker, reader, conversationOf.get(row.taskId)!));
    current.blocked ||= !isBlockerSatisfied(row.blocker.status);
  }
  for (const current of relations.values()) current.blockedBy.sort(byName);
  for (const row of parents)
    entry(row.taskId).parent = link(row.parent, reader, conversationOf.get(row.taskId)!);
  for (const row of subtasks)
    entry(row.id).subtasks = { total: Number(row.total), finished: Number(row.finished) };
  return relations;
}

export const relationsOf = (relations: ReadonlyMap<string, TaskRelations>, id: string) =>
  relations.get(id) ?? emptyRelations();

/** One Task's view, its relations read now. */
export async function taskViewOf(
  db: Client,
  reader: TaskReader,
  task: SelectedTask,
  counts?: DiscussionCounts,
): Promise<TaskView> {
  const relations = await loadTaskRelations(db, reader, [task]);
  return taskView(task, reader, { relations: relationsOf(relations, task.id), counts });
}

/** Each Task's view, the relations of the whole page read together. */
export async function taskViewsOf(
  db: Client,
  reader: TaskReader,
  tasks: readonly SelectedTask[],
): Promise<TaskView[]> {
  const relations = await loadTaskRelations(db, reader, tasks);
  return tasks.map((task) =>
    taskView(task, reader, { relations: relationsOf(relations, task.id) }),
  );
}

/**
 * The Tasks whose own view reads from `taskId`, in one read: those that wait for it (its status
 * decides their `blocked`), its parent (its progress) and its subtasks (their `parent`). A write
 * that changes what these read announces their new copies with its own.
 */
export async function relatedTasks(db: Client, task: { id: string; workspaceId: string }) {
  const taskId = task.id;
  if (!(await taskRelationsEnabled(db, task.workspaceId))) return [];
  return db.task.findMany({
    where: {
      OR: [
        { dependencies: { some: { blockedByTaskId: taskId } } },
        { childLinks: { some: { taskId } } },
        { parentLinks: { some: { parentTaskId: taskId } } },
      ],
    },
    select: taskSelection,
  });
}

async function descendantParentLinks(
  db: Client,
  task: { id: string; workspaceId: string },
): Promise<{ taskId: string; parentTaskId: string }[]> {
  return db.$queryRaw<{ taskId: string; parentTaskId: string }[]>`
    WITH RECURSIVE descendants("taskId", "parentTaskId", depth, path) AS (
      SELECT "taskId", "parentTaskId", 1, ARRAY["taskId"]
      FROM "task_parents"
      WHERE "parentTaskId" = ${task.id}::uuid
        AND "workspaceId" = ${task.workspaceId}::uuid
      UNION ALL
      SELECT child."taskId", child."parentTaskId", descendants.depth + 1,
             descendants.path || child."taskId"
      FROM "task_parents" child
      JOIN descendants ON child."parentTaskId" = descendants."taskId"
      WHERE child."workspaceId" = ${task.workspaceId}::uuid
        AND descendants.depth < ${MAX_TASK_TREE_DEPTH}
        AND NOT (child."taskId" = ANY(descendants.path))
    )
    SELECT "taskId", "parentTaskId"
    FROM descendants`;
}

/** The Tasks waiting for `task`, and its subtasks as a tree: what `show` adds to the card. */
export async function showRelations(
  db: Client,
  reader: TaskReader,
  task: { id: string; conversationId: string; workspaceId: string },
): Promise<{ blocking?: TaskLink[]; subtree?: TaskTreeNode[] }> {
  if (!(await taskRelationsEnabled(db, task.workspaceId))) return {};
  const from = task.conversationId;
  const [dependents, parentLinks] = await Promise.all([
    db.taskDependency.findMany({
      where: { blockedByTaskId: task.id },
      select: { task: { select: LINK_SELECT } },
    }),
    descendantParentLinks(db, task),
  ]);
  const blocking = dependents.map((row) => link(row.task, reader, from)).sort(byName);
  const childrenOf = new Map(
    [...groupBy(parentLinks, (row) => row.parentTaskId)].map(([id, rows]) => [
      id,
      rows.map((row) => row.taskId),
    ]),
  );
  const levels = descend(task.id, childrenOf, MAX_TASK_TREE_DEPTH);
  const seen = new Set(levels.flat());
  if (!seen.size) return { blocking, subtree: [] };
  const [rows, edges] = await Promise.all([
    db.task.findMany({
      where: { id: { in: [...seen] } },
      select: {
        id: true,
        workspaceId: true,
        ...LINK_SELECT,
        owner: { select: TASK_MEMBER_SELECT },
      },
    }),
    db.taskDependency.findMany({
      where: { taskId: { in: [...seen] } },
      select: {
        taskId: true,
        blocker: {
          select: {
            number: true,
            status: true,
            conversation: { select: NAMED_CONVERSATION_SELECT },
          },
        },
      },
    }),
  ]);
  const byId = new Map(rows.map((row) => [row.id, row]));
  const blockersOf = groupBy(edges, (row) => row.taskId);
  // `depth` is the level the node sits at; a stored cycle ends where the levels read do.
  const node = (id: string, depth: number): TaskTreeNode => {
    const row = byId.get(id)!;
    const name = taskName(row, from);
    if (name.hidden) return { hidden: true, status: storedTaskStatus(row.status), children: [] };
    // A node names only what still blocks it: a finished blocker no longer holds the node.
    const open = (blockersOf.get(id) ?? []).filter(
      (edge) => !isBlockerSatisfied(edge.blocker.status),
    );
    return {
      ...name,
      title: linkTitle(row, reader),
      status: storedTaskStatus(row.status),
      owner: row.owner && taskMember(row.workspaceId, row.owner),
      blocked: open.length > 0,
      blockedBy: open.map((edge) => taskName(edge.blocker, from)).sort(byName),
      children: depth < levels.length ? nodes(id, depth + 1) : [],
    };
  };
  const nodes = (parentId: string, depth: number): TaskTreeNode[] =>
    (childrenOf.get(parentId) ?? [])
      .filter((id) => byId.has(id))
      .map((id) => ({ id, name: taskName(byId.get(id)!, from) }))
      .sort((a, b) => byName(a.name, b.name))
      .map(({ id }) => node(id, depth));
  return { blocking, subtree: nodes(task.id, 1) };
}
