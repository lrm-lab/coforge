import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import {
  taskNameLabel,
  taskPriorityRank,
  type TaskPriority,
  type TaskStatus,
} from "@lrm/coforge-sdk/internal";
import type { ConversationRef, Member, Transaction } from "./task-board-ports.server";
import { loadTaskRelations, relationsOf } from "./task-relations.server";
import {
  NAMED_CONVERSATION_SELECT,
  UNFINISHED_TASK_STATUSES,
  storedTaskPriority,
  storedTaskStatus,
  taskName,
  type NamedConversation,
  type TaskReader,
} from "./task-view.server";

/**
 * An Agent's own task queue (task #716): the one ordering every reader of "what should I do
 * next" shares — `list --mine`, an assignment notice and the idle reminder. A Task enters the
 * queue when it is Todo or In Progress and no unfinished blocker holds it; In Review, a blocked
 * Task and a finished one wait outside it. Order is highest priority first, oldest first within
 * a level, id for stability — the order `list --mine` and the idle reminder always used.
 */

/** The fields the queue reads of one Task: enough to order it and to say whether it can start. */
export type QueueTask = {
  id: string;
  status: TaskStatus;
  priority?: TaskPriority;
  blocked: boolean;
  createdAt: Date | string;
};

const queueTime = (at: Date | string) => (typeof at === "string" ? Date.parse(at) : at.getTime());

/** Queue order: priority rank, then oldest first, then id so the order never depends on input. */
export function compareQueueTasks(left: QueueTask, right: QueueTask): number {
  return (
    taskPriorityRank(left.priority) - taskPriorityRank(right.priority) ||
    queueTime(left.createdAt) - queueTime(right.createdAt) ||
    left.id.localeCompare(right.id)
  );
}

/** Whether the queue numbers the Task: work that can start now. */
export function queueActionable(task: Pick<QueueTask, "status" | "blocked">): boolean {
  return (task.status === "todo" || task.status === "in_progress") && !task.blocked;
}

export type OwnTaskQueue<T extends QueueTask> = {
  /** The numbered queue in order; `position` is the Task's 1-based number. */
  queue: { task: T; position: number }[];
  /** Each queued Task's id → its position, for lookups over a wider set. */
  positions: ReadonlyMap<string, number>;
};

/**
 * The numbered queue over `tasks` — every Task they hold, however the caller filtered its own
 * read: positions always count the whole set, so a filtered row still shows its true rank.
 */
export function ownTaskQueue<T extends QueueTask>(tasks: readonly T[]): OwnTaskQueue<T> {
  const ordered = tasks.filter(queueActionable).sort(compareQueueTasks);
  return {
    queue: ordered.map((task, index) => ({ task, position: index + 1 })),
    positions: new Map(ordered.map((task, index) => [task.id, index + 1])),
  };
}

type Client = PrismaClient | Transaction;

/** A queue candidate as `readOwnQueueTasks` reads it: the queue fields plus what naming the
 * Task from another conversation needs (`taskName`). */
export type QueueTaskRow = QueueTask & {
  number: number;
  conversationId: string;
  workspaceId: string;
  conversation: NamedConversation;
};

/**
 * Every unfinished Task `actor` holds in `conversations` (an `ownTaskScope` result's), with each
 * one's `blocked` read. One relations read however many Tasks there are; with Tasks v2 off no
 * relations exist and nothing is blocked.
 */
export async function readOwnQueueTasks(
  db: Client,
  reader: TaskReader,
  workspaceId: string,
  actor: { agentId: string } | { userId: string },
  conversations: Prisma.ConversationWhereInput,
): Promise<QueueTaskRow[]> {
  const rows = await db.task.findMany({
    where: {
      workspaceId,
      owner: actor,
      deletedAt: null,
      status: { in: UNFINISHED_TASK_STATUSES },
      conversation: conversations,
    },
    select: {
      id: true,
      number: true,
      status: true,
      priority: true,
      createdAt: true,
      conversationId: true,
      workspaceId: true,
      conversation: { select: NAMED_CONVERSATION_SELECT },
    },
  });
  const relations = await loadTaskRelations(db, reader, rows);
  return rows.map((row) => ({
    id: row.id,
    number: row.number,
    status: storedTaskStatus(row.status, { number: row.number }),
    priority: storedTaskPriority(row.priority),
    blocked: relationsOf(relations, row.id).blocked,
    createdAt: row.createdAt,
    conversationId: row.conversationId,
    workspaceId: row.workspaceId,
    conversation: row.conversation,
  }));
}

/**
 * The queue note an assignment receipt carries, per assigned Task id (task #716). A person's
 * assignment is a direct instruction — "do it first", never a number (Frank's rule: the queue
 * only orders what nobody has intervened in). An Agent's or the system's assignment names the
 * Task's position in the assignee's queue and the Tasks immediately ahead of it; a Task that
 * does not enter the queue (In Review, blocked, finished) gets no note, and neither does a
 * person assignee — the queue is an Agent's. `conversations` is the assignee's `ownTaskScope`
 * read, passed in so this module stays below `task-list`.
 */
export async function assignmentQueueNotes(
  db: Client,
  reader: TaskReader,
  conversation: ConversationRef,
  member: Member,
  assignee: { agentId: string | null },
  tasks: readonly { id: string }[],
  conversations: Prisma.ConversationWhereInput,
): Promise<ReadonlyMap<string, string>> {
  const notes = new Map<string, string>();
  if (!assignee.agentId || tasks.length === 0) return notes;
  if (member.userId) {
    for (const task of tasks) notes.set(task.id, "do it first");
    return notes;
  }
  const { queue } = ownTaskQueue(
    await readOwnQueueTasks(
      db,
      reader,
      conversation.workspaceId,
      { agentId: assignee.agentId },
      conversations,
    ),
  );
  const wanted = new Set(tasks.map((task) => task.id));
  for (const [index, entry] of queue.entries()) {
    if (!wanted.has(entry.task.id)) continue;
    const ahead = queue
      .slice(Math.max(0, index - 3), index)
      .map((aheadEntry) => taskNameLabel(taskName(aheadEntry.task, conversation.conversationId)));
    notes.set(
      entry.task.id,
      `queue #${entry.position}${ahead.length ? ` (ahead: ${ahead.join(", ")})` : ""}`,
    );
  }
  return notes;
}
