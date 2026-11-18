import { mergeTimeline, type TaskHistoryEvent } from "@lrm/coforge-sdk/internal";
import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import type { BrowserMessageMentionRow } from "#src/server/conversations/mentions.server";
import { browserSenderHandle } from "#src/server/conversations/sender-display.server";
import { historyEventView } from "./task-history.server";
import type { TaskReader } from "./task-view.server";

/**
 * A Task's discussion and its change history read as one stream: the messages of its own
 * conversation merged with its history events. History is the single record of a change, so the
 * three notices it also posted in the conversation (a move, a claim, an unassign) are not read.
 */
const HIDDEN_TASK_THREAD_NOTICE_KINDS = ["task.moved", "task.claimed", "task.unassigned"];

export const VISIBLE_TASK_THREAD_MESSAGE_WHERE = {
  NOT: { systemMessage: { kind: { in: HIDDEN_TASK_THREAD_NOTICE_KINDS } } },
} satisfies Prisma.MessageWhereInput;

type Db = Pick<PrismaClient, "taskHistoryEvent" | "message">;

/**
 * The events a page of the conversation owns. An event belongs to the page holding the first
 * message at or after it, and reads just before that message: a page owns the events after the
 * newest message older than the page (`after`) and through its own newest message (`through`,
 * none for the page holding the newest message). Pages cut this way own every event once.
 */
type TaskEventWindow = { after?: Date; through?: Date };

type Mentions = readonly BrowserMessageMentionRow[];

export async function taskEventsInWindow(
  db: Db,
  taskId: string,
  reader: TaskReader,
  mentions: Mentions,
  window: TaskEventWindow,
): Promise<TaskHistoryEvent[]> {
  const rows = await db.taskHistoryEvent.findMany({
    where: { taskId, createdAt: { gt: window.after, lte: window.through } },
    orderBy: [{ createdAt: "asc" }, { seq: "asc" }],
  });
  return rows.map((event) => historyEventView(event, reader, mentions));
}

/** The newest `limit` events, oldest first, and whether the Task has older ones. */
async function newestTaskEvents(
  db: Db,
  taskId: string,
  reader: TaskReader,
  mentions: Mentions,
  limit: number,
) {
  const rows = await db.taskHistoryEvent.findMany({
    where: { taskId },
    orderBy: [{ createdAt: "desc" }, { seq: "desc" }],
    take: limit + 1,
  });
  return {
    events: rows
      .slice(0, limit)
      .reverse()
      .map((event) => historyEventView(event, reader, mentions)),
    hasOlder: rows.length > limit,
  };
}

/** The newest `limit` entries of the merged stream, split back into messages and events. */
function newestTimeline<
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

export async function visibleTimeUpTo(db: Db, conversationId: string, sequence: number) {
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
    mentions: Mentions;
    afterSequence: number;
    through?: Date;
  },
) {
  const after = await visibleTimeUpTo(db, input.conversationId, input.afterSequence);
  return taskEventsInWindow(db, input.taskId, input.reader, input.mentions, {
    after,
    through: input.through,
  });
}

async function newestVisibleMessages(db: Db, conversationId: string, limit: number) {
  const where = { conversationId, ...VISIBLE_TASK_THREAD_MESSAGE_WHERE };
  const [total, rows] = await Promise.all([
    db.message.count({ where }),
    db.message.findMany({
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
    }),
  ]);
  const messages = rows.reverse().map((row) => ({
    id: row.id,
    sequence: row.sequence,
    body: row.body,
    createdAt: row.createdAt.toISOString(),
    sender: browserSenderHandle(row.sender) ?? null,
  }));
  return { total, messages };
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
  mentions: Mentions,
  limit: number,
) {
  const conversationId = task.discussionConversationId;
  const [thread, eventPage] = await Promise.all([
    conversationId ? newestVisibleMessages(db, conversationId, limit) : { total: 0, messages: [] },
    newestTaskEvents(db, task.id, reader, mentions, limit),
  ]);
  const shown = newestTimeline(thread.messages, eventPage.events, limit);
  const shownCount = shown.messages.length + shown.events.length;
  return {
    exists: conversationId !== null,
    replyCount: thread.total,
    messages: shown.messages,
    events: shown.events,
    hasOlder: thread.total + eventPage.events.length + (eventPage.hasOlder ? 1 : 0) > shownCount,
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
    conversationId: string;
    reader: TaskReader;
    mentions: Mentions;
    messages: readonly { sequence: number; createdAt: Date }[];
    hasNewer: boolean;
    unreadAfterSequence?: number;
  },
) {
  const { taskId, conversationId, reader, mentions, messages } = input;
  const first = messages[0];
  const last = messages.at(-1);
  const through = input.hasNewer ? last?.createdAt : undefined;
  if (input.unreadAfterSequence !== undefined)
    return taskEventsAfterMessage(db, {
      taskId,
      conversationId,
      reader,
      mentions,
      afterSequence: input.unreadAfterSequence,
      through,
    });
  if (!first || !last) {
    const [readable, events] = await Promise.all([
      db.message.count({
        where: { conversationId, ...VISIBLE_TASK_THREAD_MESSAGE_WHERE },
        take: 1,
      }),
      taskEventsInWindow(db, taskId, reader, mentions, {}),
    ]);
    return readable ? [] : events;
  }
  return taskEventsAfterMessage(db, {
    taskId,
    conversationId,
    reader,
    mentions,
    afterSequence: first.sequence - 1,
    through,
  });
}
