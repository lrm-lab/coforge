import { mergeTimeline, type TaskHistoryEvent } from "@lrm/coforge-sdk/internal";
import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import { BROWSER_MESSAGE_MENTIONS_SELECT } from "#src/server/conversations/mentions.server";
import { historyEventView } from "./task-history.server";
import { taskMentions, type TaskReader } from "./task-view.server";

/**
 * A Task's discussion and its change history read as one stream: the messages of its own
 * conversation merged with its history events. History is the single record of a change, so the
 * three notices it also posted in the conversation (a move, a claim, an unassign) are not read.
 */
export const HIDDEN_TASK_THREAD_NOTICE_KINDS = ["task.moved", "task.claimed", "task.unassigned"];

export const VISIBLE_TASK_THREAD_MESSAGE_WHERE = {
  NOT: { systemMessage: { kind: { in: HIDDEN_TASK_THREAD_NOTICE_KINDS } } },
} satisfies Prisma.MessageWhereInput;

type Db = Pick<PrismaClient, "task" | "taskHistoryEvent" | "message">;

/**
 * The events a page of the conversation owns. An event belongs to the page holding the first
 * message at or after it, and reads just before that message: a page owns the events after the
 * newest message older than the page (`after`) and through its own newest message (`through`,
 * none for the page holding the newest message). Pages cut this way own every event once.
 */
export type TaskEventWindow = { after?: Date; through?: Date };

async function mentionsOf(db: Db, taskId: string) {
  const task = await db.task.findUniqueOrThrow({
    where: { id: taskId },
    select: {
      message: { select: { sequence: true, mentions: BROWSER_MESSAGE_MENTIONS_SELECT } },
    },
  });
  return taskMentions(task);
}

export async function taskEventsInWindow(
  db: Db,
  taskId: string,
  reader: TaskReader,
  window: TaskEventWindow = {},
): Promise<TaskHistoryEvent[]> {
  const [rows, mentions] = await Promise.all([
    db.taskHistoryEvent.findMany({
      where: {
        taskId,
        ...(window.after || window.through
          ? { createdAt: { gt: window.after, lte: window.through } }
          : {}),
      },
      orderBy: [{ createdAt: "asc" }, { seq: "asc" }],
    }),
    mentionsOf(db, taskId),
  ]);
  return rows.map((event) => historyEventView(event, reader, mentions));
}

/** The newest `limit` events, oldest first, and how many the Task has. */
export async function newestTaskEvents(
  db: Db,
  taskId: string,
  reader: TaskReader,
  limit: number,
): Promise<{ events: TaskHistoryEvent[]; total: number }> {
  const [rows, total, mentions] = await Promise.all([
    db.taskHistoryEvent.findMany({
      where: { taskId },
      orderBy: [{ createdAt: "desc" }, { seq: "desc" }],
      take: limit,
    }),
    db.taskHistoryEvent.count({ where: { taskId } }),
    mentionsOf(db, taskId),
  ]);
  return {
    events: rows.reverse().map((event) => historyEventView(event, reader, mentions)),
    total,
  };
}

/** The newest `limit` entries of the merged stream, split back into messages and events. */
export function newestTimeline<
  Message extends { createdAt: string; sequence: number },
  Event extends { createdAt: string; seq: number },
>(messages: readonly Message[], events: readonly Event[], limit: number) {
  const shown = mergeTimeline(messages, events).slice(-limit);
  return {
    messages: shown.flatMap((entry) => (entry.kind === "message" ? [entry.message] : [])),
    events: shown.flatMap((entry) => (entry.kind === "event" ? [entry.event] : [])),
  };
}

export async function messageTime(db: Db, conversationId: string, sequence: number) {
  const row = await db.message.findFirst({
    where: { conversationId, sequence },
    select: { createdAt: true },
  });
  return row?.createdAt;
}

async function visibleTimeUpTo(db: Db, conversationId: string, sequence: number) {
  const row = await db.message.findFirst({
    where: { conversationId, sequence: { lte: sequence }, ...VISIBLE_TASK_THREAD_MESSAGE_WHERE },
    orderBy: { sequence: "desc" },
    select: { createdAt: true },
  });
  return row?.createdAt;
}

/**
 * The events a page owns: those after the newest readable message at or below `afterSequence` (none
 * below it: from the first event) and through `through`.
 */
export async function taskEventsAfterMessage(
  db: Db,
  input: {
    taskId: string;
    conversationId: string;
    reader: TaskReader;
    afterSequence: number;
    through?: Date;
  },
) {
  const after = await visibleTimeUpTo(db, input.conversationId, input.afterSequence);
  return taskEventsInWindow(db, input.taskId, input.reader, { after, through: input.through });
}

/**
 * `task view`: the newest `limit` entries of the merged stream. `replyCount` is the conversation's
 * messages as read (the hidden notices not counted); `hasOlder` says whether entries of either kind
 * lie before the ones shown.
 */
export async function taskTimelinePage(
  db: Db,
  task: { id: string; discussionConversationId: string | null },
  reader: TaskReader,
  limit: number,
) {
  const conversationId = task.discussionConversationId;
  const where = { conversationId: conversationId ?? "", ...VISIBLE_TASK_THREAD_MESSAGE_WHERE };
  const [total, rows, eventPage] = await Promise.all([
    conversationId ? db.message.count({ where }) : 0,
    conversationId
      ? db.message.findMany({
          where,
          orderBy: { sequence: "desc" },
          take: limit,
          select: {
            id: true,
            sequence: true,
            body: true,
            createdAt: true,
            sender: {
              select: {
                user: { select: { username: true } },
                agent: { select: { name: true } },
              },
            },
          },
        })
      : [],
    newestTaskEvents(db, task.id, reader, limit),
  ]);
  const messages = rows.reverse().map((row) => ({
    id: row.id,
    sequence: row.sequence,
    body: row.body,
    createdAt: row.createdAt.toISOString(),
    sender: row.sender?.agent?.name ?? row.sender?.user?.username ?? null,
  }));
  const shown = newestTimeline(messages, eventPage.events, limit);
  return {
    exists: conversationId !== null,
    replyCount: total,
    messages: shown.messages,
    events: shown.events,
    hasOlder: total + eventPage.total > shown.messages.length + shown.events.length,
  };
}

/**
 * The events `task read` shows with one page of messages. A page after a read position (`unread`)
 * starts at that position, so what changed since it shows even when no message came.
 */
export async function taskEventsForReadPage(
  db: Db,
  input: {
    taskId: string;
    conversationId: string | null;
    reader: TaskReader;
    messages: readonly { sequence: number; createdAt: Date }[];
    hasNewer: boolean;
    unreadAfterSequence?: number;
  },
) {
  const { taskId, conversationId, reader, messages } = input;
  const first = messages[0];
  const last = messages.at(-1);
  if (conversationId && input.unreadAfterSequence !== undefined)
    return taskEventsAfterMessage(db, {
      taskId,
      conversationId,
      reader,
      afterSequence: input.unreadAfterSequence,
      through: input.hasNewer ? last?.createdAt : undefined,
    });
  if (!first || !last || !conversationId) {
    const readable =
      conversationId &&
      (await db.message.count({
        where: { conversationId, ...VISIBLE_TASK_THREAD_MESSAGE_WHERE },
        take: 1,
      }));
    return readable ? [] : taskEventsInWindow(db, taskId, reader);
  }
  return taskEventsAfterMessage(db, {
    taskId,
    conversationId,
    reader,
    afterSequence: first.sequence - 1,
    through: input.hasNewer ? last.createdAt : undefined,
  });
}
