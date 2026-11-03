import type { TaskPriority, TaskStatus } from "@lrm/coforge-sdk/internal";
import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import { BROWSER_MESSAGE_MENTIONS_SELECT } from "#src/server/conversations/mentions.server";
import { boardLabel } from "./task-conversations.server";
import { ownTaskScope } from "./task-list.server";
import {
  FINISHED_TASK_STATUSES,
  NAMED_CONVERSATION_SELECT,
  UNFINISHED_TASK_STATUSES,
  placeFrom,
  readTaskText,
  storedTaskPriority,
  storedTaskStatus,
} from "./task-view.server";

/**
 * What the idle reminder knows of each open Task assigned to one Agent: when it was given the
 * Task and by whom, the last activity on it, the last thing someone else did, and what holds it
 * back. Read in a fixed number of queries however many Tasks the Agent holds.
 *
 * History records an actor by handle, so the Agent's own events are those of an Agent with its
 * name. Agent names are fixed at creation; an Agent that reuses a deleted Agent's name reads that
 * Agent's old events as its own. Server (`system`) events are nobody's: neither its own nor
 * someone else's.
 */
export type IdleTaskFacts = {
  id: string;
  ref: string;
  channel: string;
  taskNumber: number;
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  createdAt: Date;
  /** The newest assignment to this Agent, and whether it claimed the Task itself. */
  givenAt: Date | null;
  givenBySelf: boolean;
  /** The newest history event, conversation message or finished blocker; else the Task's creation. */
  lastActivityAt: Date;
  /** The newest history event, and the newest conversation message, by someone else. */
  othersChangedAt: Date | null;
  othersRepliedAt: Date | null;
  /** In review, put there by the Agent itself: it waits for others. */
  ownReview: boolean;
  /** A blocker not done or closed; a subtask not done or closed. */
  blocked: boolean;
  openSubtasks: boolean;
  /**
   * The blocker someone else finished last, once none is left open, and when. `ref` is null when
   * the blocker is in a private channel or a DM, which a Task is not named from elsewhere.
   */
  blockerDone: { ref: string | null; at: Date } | null;
};

const OPEN_STATUSES = ["todo", "in_progress", "in_review"];

const BOARD_SELECT = {
  ...NAMED_CONVERSATION_SELECT,
  members: {
    where: { userId: { not: null } },
    select: { user: { select: { username: true } } },
    take: 1,
  },
} satisfies Prisma.ConversationSelect;

type Board = Prisma.ConversationGetPayload<{ select: typeof BOARD_SELECT }>;

/** `#channel`, or `dm:@peer` for a Task on a direct board, as task conversation refs name it. */
const boardOf = (board: Board) => boardLabel(board.channelName, board.members[0]?.user?.username);

const latest = (dates: (Date | null | undefined)[]) =>
  dates.reduce<Date | null>(
    (newest, date) => (date && (!newest || date > newest) ? date : newest),
    null,
  );

/** The open Tasks assigned to `agent`, in the conversations `task list --mine` reads. */
export async function readIdleTaskFacts(
  db: PrismaClient,
  agent: { workspaceId: string; agentId: string; name: string },
): Promise<IdleTaskFacts[]> {
  const tasks = await db.task.findMany({
    where: {
      workspaceId: agent.workspaceId,
      owner: { agentId: agent.agentId },
      status: { in: OPEN_STATUSES },
      conversation: ownTaskScope({ agentId: agent.agentId }).conversations,
    },
    select: {
      id: true,
      number: true,
      title: true,
      status: true,
      priority: true,
      createdAt: true,
      messageId: true,
      conversationId: true,
      discussionConversationId: true,
      conversation: { select: BOARD_SELECT },
      message: { select: { mentions: BROWSER_MESSAGE_MENTIONS_SELECT } },
    },
  });
  if (tasks.length === 0) return [];
  const ids = tasks.map((task) => task.id);
  const isSelf = (event: { actorType: string; actorName: string | null }) =>
    event.actorType === "agent" && event.actorName === agent.name;
  const byOthers = {
    OR: [{ actorType: "user" }, { actorType: "agent", NOT: { actorName: agent.name } }],
  } satisfies Prisma.TaskHistoryEventWhereInput;

  const [lastEvents, othersEvents, moves, replies, others, dependencies, subtasks] =
    await Promise.all([
      db.taskHistoryEvent.groupBy({
        by: ["taskId"],
        where: { taskId: { in: ids }, NOT: { actorType: "system" } },
        _max: { createdAt: true },
      }),
      db.taskHistoryEvent.groupBy({
        by: ["taskId"],
        where: { taskId: { in: ids }, ...byOthers },
        _max: { createdAt: true },
      }),
      // Only assignments and status moves: who gave it, and who put it in review.
      db.taskHistoryEvent.findMany({
        where: { taskId: { in: ids }, eventType: { in: ["assignee_changed", "status_changed"] } },
        select: {
          taskId: true,
          eventType: true,
          actorType: true,
          actorName: true,
          payload: true,
          createdAt: true,
        },
        orderBy: [{ createdAt: "desc" }, { seq: "desc" }],
      }),
      conversationMessages(db, agent.workspaceId, tasks, {}),
      conversationMessages(db, agent.workspaceId, tasks, {
        NOT: { sender: { is: { agentId: agent.agentId } } },
      }),
      db.taskDependency.findMany({
        where: { taskId: { in: ids } },
        select: {
          taskId: true,
          blocker: {
            select: {
              id: true,
              number: true,
              status: true,
              conversation: { select: NAMED_CONVERSATION_SELECT },
            },
          },
        },
      }),
      db.taskParent.findMany({
        where: { parentTaskId: { in: ids }, task: { status: { in: UNFINISHED_TASK_STATUSES } } },
        select: { parentTaskId: true },
      }),
    ]);
  const finished = (status: unknown) =>
    (FINISHED_TASK_STATUSES as readonly unknown[]).includes(status);
  const finishedBlockerIds = dependencies
    .filter((row) => finished(row.blocker.status))
    .map((row) => row.blocker.id);
  // When each finished blocker was last finished by someone other than this Agent.
  const finishedAt = new Map<string, Date>();
  if (finishedBlockerIds.length > 0)
    for (const event of await db.taskHistoryEvent.findMany({
      where: { taskId: { in: finishedBlockerIds }, eventType: "status_changed", ...byOthers },
      select: { taskId: true, payload: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    }))
      if (finished(field(event.payload, "to"))) finishedAt.set(event.taskId, event.createdAt);
  const withOpenSubtasks = new Set(subtasks.map((row) => row.parentTaskId));
  const maxOf = (rows: typeof lastEvents, taskId: string) =>
    rows.find((row) => row.taskId === taskId)?._max.createdAt ?? null;

  return tasks.map((task) => {
    const own = moves.filter((event) => event.taskId === task.id);
    const given = own.find(
      (event) =>
        event.eventType === "assignee_changed" &&
        field(event.payload, "assigneeId") === agent.agentId,
    );
    const review = own.find(
      (event) => event.eventType === "status_changed" && field(event.payload, "to") === "in_review",
    );
    const status = storedTaskStatus(task.status);
    const blockers = dependencies.filter((row) => row.taskId === task.id);
    const blocked = blockers.some((row) => !finished(row.blocker.status));
    const done = blocked
      ? undefined
      : blockers
          .filter((row) => finishedAt.has(row.blocker.id))
          .map((row) => {
            const channel = placeFrom(row.blocker.conversation, task.conversationId);
            const board = channel === null ? boardOf(task.conversation) : `#${channel}`;
            return {
              ref: channel === undefined ? null : `${board}:#${row.blocker.number}`,
              at: finishedAt.get(row.blocker.id)!,
            };
          })
          .sort((left, right) => right.at.getTime() - left.at.getTime())[0];
    const board = boardOf(task.conversation);
    return {
      id: task.id,
      ref: `${board}:#${task.number}`,
      channel: board,
      taskNumber: task.number,
      title: readTaskText(task.title, "agent", task.message?.mentions ?? []),
      status,
      priority: storedTaskPriority(task.priority),
      createdAt: task.createdAt,
      givenAt: given?.createdAt ?? null,
      givenBySelf: given ? isSelf(given) : false,
      lastActivityAt:
        latest([task.createdAt, maxOf(lastEvents, task.id), replies.get(task.id), done?.at]) ??
        task.createdAt,
      othersChangedAt: maxOf(othersEvents, task.id),
      othersRepliedAt: others.get(task.id) ?? null,
      ownReview: status === "in_review" && review !== undefined && isSelf(review),
      blocked,
      openSubtasks: withOpenSubtasks.has(task.id),
      blockerDone: done ?? null,
    };
  });
}

/**
 * The newest member-sent message (server notices have no sender) in each Task's conversation, by
 * Task id: its own conversation, or the thread of the message an earlier Task started as.
 */
async function conversationMessages(
  db: PrismaClient,
  workspaceId: string,
  tasks: {
    id: string;
    conversationId: string;
    messageId: string | null;
    discussionConversationId: string | null;
  }[],
  sender: Prisma.MessageWhereInput,
) {
  const discussions = tasks.filter((task) => task.discussionConversationId);
  const threads = tasks.filter((task) => task.messageId);
  const where = {
    workspaceId,
    senderMemberId: { not: null },
    ...sender,
  } satisfies Prisma.MessageWhereInput;
  const [inDiscussions, inThreads] = await Promise.all([
    discussions.length === 0
      ? []
      : db.message.groupBy({
          by: ["conversationId"],
          where: {
            ...where,
            conversationId: { in: discussions.map((task) => task.discussionConversationId!) },
          },
          _max: { createdAt: true },
        }),
    // A thread's replies are in its root's conversation: `(conversationId, threadRootId, …)`.
    threads.length === 0
      ? []
      : db.message.groupBy({
          by: ["threadRootId"],
          where: {
            ...where,
            conversationId: { in: [...new Set(threads.map((task) => task.conversationId))] },
            threadRootId: { in: threads.map((task) => task.messageId!) },
          },
          _max: { createdAt: true },
        }),
  ]);
  const newest = new Map<string, Date>();
  for (const task of tasks) {
    const date = latest([
      inDiscussions.find((row) => row.conversationId === task.discussionConversationId)?._max
        .createdAt,
      inThreads.find((row) => task.messageId && row.threadRootId === task.messageId)?._max
        .createdAt,
    ]);
    if (date) newest.set(task.id, date);
  }
  return newest;
}

const field = (payload: Prisma.JsonValue, key: string) =>
  payload && typeof payload === "object" && !Array.isArray(payload) ? payload[key] : undefined;
