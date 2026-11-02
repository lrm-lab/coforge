import type { Prisma } from "#src/generated/prisma/client";
import { announceMessageBestEffort } from "#src/server/conversations/conversation-activity.server";
import { hostMessageId } from "./task-view.server";
import { postTaskNotice } from "./task-conversations.server";
import { taskRelationsEnabled } from "./task-conversations-gate.server";
import { followTask } from "./task-discussion-store.server";
import { enrollThreadReplyFollowers } from "#src/server/conversations/channel-threads.server";
import {
  lockConversation,
  lockWorkspaceTaskWrites,
} from "#src/server/conversations/conversation-lock.server";
import { allocateSequence } from "#src/server/db/repositories/sequence-allocation.server";
import { publishAssignmentReceipt } from "./task-publication.server";
import {
  noticeText,
  quotedTask,
  type NoticeActor,
  type QuotedPlace,
  type QuotedTask,
} from "./task-notices.server";
import { NAMED_CONVERSATION_SELECT, placeFrom } from "./task-view.server";
import type { SystemNotice, SystemNoticeContent } from "#src/features/conversations/system-notice";
import type {
  Transaction,
  TaskBoardPorts,
  Member,
  Assignee,
  ConversationRef,
} from "./task-board-ports.server";

export type PostedNotice = ConversationRef & {
  id: string;
  sequence: number;
  threadRootId: string | null;
  body: string;
};
type NoticeInput = {
  id?: string;
  threadRootId?: string;
  body: string;
  system: SystemNotice;
  deliverTo?: string | null;
  /** The member the notice personally mentions: its one mention row. */
  mentions?: Assignee;
};
/**
 * The Task fields a notice quotes; `messageId` is also the root of the Task's thread. A Task in
 * another conversation than the notice's names it, so a notice quotes it with its channel, or
 * hidden when the notice's readers may not read that channel.
 */
export type NoticeSubject = {
  id: string;
  messageId: string | null;
  number: number;
  title: string;
  conversationId?: string;
};
/**
 * Write notices under the withNotices conversation lock; signal after commit. Assignment
 * receipts are delivered/pushed separately by the caller through publishAssignmentReceipt.
 */
export type NoticeWriter = {
  /**
   * Lock the other conversations this write is about to post notices into, in ascending id order.
   * Call it once the Tasks to tell are known and before telling any, so they are locked together.
   */
  prepare(conversationIds: readonly string[]): Promise<void>;
  /** The Tasks as notices quote them: clean titles, in the given order. */
  quote(tasks: readonly NoticeSubject[]): Promise<QuotedTask[]>;
  /** A top-level notice in the conversation; `id` fixes it, for a notice written at most once. */
  inConversation(notice: SystemNoticeContent, id?: string): Promise<PostedNotice>;
  /** A reply in the Task's own thread. */
  inThread(
    task: NoticeSubject,
    body: (task: QuotedTask) => SystemNoticeContent,
  ): Promise<PostedNotice>;
  /**
   * Fixed-id receipt in the Task's own thread, with an assignee mention (overrides human mute)
   * and one delivery to an Agent assignee other than the actor, whose target is that thread.
   * Self-assigned Agents already hold it in the result. The assignee follows the thread, so its
   * later replies reach them. The body is server-built @handle text.
   */
  receipt(input: {
    id: string;
    task: NoticeSubject;
    body: (task: QuotedTask) => SystemNoticeContent;
    assignee: Assignee;
    actor: Member;
  }): Promise<PostedNotice>;
  /**
   * A notice in the Task's own thread addressed to its owner or reserved assignee: it mentions
   * them (a person hears of it as an Activity mention) and is delivered to `deliverTo`, an Agent
   * owner, and nobody else. With no owner it is an ordinary thread notice, delivered to no one.
   * `content` is given the quoted Task and the quoted `related` Tasks, as the Task's own
   * conversation names them. A Task in another conversation than this writer's is told in its own, in this same transaction: its conversation is
   * locked here if `prepare` did not already. Delivery and push follow the commit.
   */
  toOwner(input: ToOwnerInput): Promise<void>;
};

type ToOwnerInput = {
  id: string;
  task: NoticeSubject;
  related?: readonly NoticeSubject[];
  content: (task: QuotedTask, related: QuotedTask[]) => SystemNoticeContent;
  owner: Assignee | null;
  deliverTo: string | null;
};

/**
 * Task notice writes share the ordinary-send conversation lock to allocate sequences.
 * withNotices always locks, commits, then signals the posted notices.
 */
export async function withNotices<T>(
  ports: TaskBoardPorts,
  conversation: ConversationRef,
  change: (tx: Transaction, notices: NoticeWriter) => Promise<T>,
): Promise<T> {
  const posted: PostedNotice[] = [];
  const addressed: PostedNotice[] = [];
  // In a Workspace with Tasks v2 on, a Task write can wake a Task in another conversation, so every
  // Task write takes the Workspace's lock before any conversation lock (see `AGENTS.md`).
  const lockedWorkspace = await taskRelationsEnabled(ports.db, conversation.workspaceId);
  const result = await ports.db.$transaction(async (tx) => {
    if (lockedWorkspace) await lockWorkspaceTaskWrites(tx, conversation.workspaceId);
    await lockConversation(tx, conversation.conversationId);
    const writers = new Map<string, NoticeWriter>();
    /** The writer of another conversation of the Workspace, which it locks the first time. */
    const writerIn = async (conversationId: string) => {
      const known = writers.get(conversationId);
      if (known) return known;
      await lockConversation(tx, conversationId);
      return writerFor({ conversationId, workspaceId: conversation.workspaceId });
    };
    const writerFor = (conversation: ConversationRef): NoticeWriter => {
      const writer = createWriter(conversation);
      writers.set(conversation.conversationId, writer);
      return writer;
    };
    const createWriter = (conversation: ConversationRef): NoticeWriter => {
      const post = (input: NoticeInput) => writeNotice(tx, conversation, input);
      const postAndSignal = async (input: NoticeInput) => {
        const notice = await post(input);
        posted.push(notice);
        return notice;
      };
      const quote = async (tasks: readonly NoticeSubject[]) => {
        const others = [
          ...new Set(
            tasks.flatMap((task) =>
              task.conversationId && task.conversationId !== conversation.conversationId
                ? [task.conversationId]
                : [],
            ),
          ),
        ];
        const [mentions, places] = await Promise.all([
          tx.messageMention.findMany({
            where: {
              messageId: { in: tasks.flatMap((task) => (task.messageId ? [task.messageId] : [])) },
            },
            select: { messageId: true, kind: true, actorId: true, handle: true },
          }),
          others.length
            ? tx.conversation.findMany({
                where: { id: { in: others } },
                select: NAMED_CONVERSATION_SELECT,
              })
            : [],
        ]);
        const placeOf = (task: NoticeSubject): QuotedPlace | undefined => {
          if (!task.conversationId || task.conversationId === conversation.conversationId)
            return undefined;
          const named = places.find((place) => place.id === task.conversationId);
          const channel = named && placeFrom(named, conversation.conversationId);
          return typeof channel === "string" ? { channel } : { hidden: true };
        };
        return tasks.map((task) =>
          quotedTask(
            task,
            mentions.filter((mention) => mention.messageId === task.messageId),
            placeOf(task),
          ),
        );
      };
      /**
       * A notice in a Task's own thread: a reply to its message, or, for a Task with no message in
       * the channel, a notice in its own conversation (which has no mentions). `id` fixes it.
       */
      const inTaskThread = async (
        task: NoticeSubject,
        content: SystemNoticeContent & { id?: string },
        to: { deliverTo?: string | null; mentions?: Assignee } = {},
      ): Promise<PostedNotice> => {
        if (!task.messageId) {
          const { id, body, system } = content;
          const placed = await postTaskNotice(tx, conversation, task.id, {
            id,
            body,
            system,
            deliverToAgentId: to.deliverTo,
          });
          return { ...placed, threadRootId: null };
        }
        return post({ ...content, threadRootId: task.messageId, ...to });
      };
      return {
        prepare: async (conversationIds) => {
          for (const id of [...new Set(conversationIds)].sort()) await writerIn(id);
        },
        quote,
        inConversation: (notice, id) => postAndSignal({ ...notice, id }),
        inThread: async (task, body) => {
          const [quoted] = await quote([task]);
          const notice = await inTaskThread(task, body(quoted!));
          // A task with no message in the channel keeps its notices in its own conversation.
          if (task.messageId) posted.push(notice);
          return notice;
        },
        toOwner: async (input) => {
          const { id, task, owner, deliverTo } = input;
          if (task.conversationId && task.conversationId !== conversation.conversationId)
            return (await writerIn(task.conversationId)).toOwner(input);
          const [quoted, ...related] = await quote([task, ...(input.related ?? [])]);
          const notice = await inTaskThread(
            task,
            { ...input.content(quoted!, related), id },
            owner ? { deliverTo, mentions: owner } : {},
          );
          if (owner) addressed.push(notice);
          else if (task.messageId) posted.push(notice);
        },
        receipt: async ({ id, task, body, assignee, actor }) => {
          const [quoted] = await quote([task]);
          const self = assignee.id === actor.id;
          const notice = await inTaskThread(
            task,
            { ...body(quoted!), id },
            { deliverTo: self ? null : assignee.agentId, mentions: assignee },
          );
          // A task with no message in the channel: the assignee follows the task.
          if (!task.messageId) {
            await followTask(tx, conversation, task.id, assignee.id, self ? "claimed" : "assigned");
            return notice;
          }
          // The receipt is the thread's first reply when it starts the thread, so it enrolls as a
          // reply does: the assignee, and the root's author while nobody follows yet.
          const root = await tx.message.findUniqueOrThrow({
            where: { id: hostMessageId(task) },
            select: { senderMemberId: true },
          });
          await enrollThreadReplyFollowers(tx, {
            workspaceId: conversation.workspaceId,
            conversationId: conversation.conversationId,
            root: { id: hostMessageId(task), senderMemberId: root.senderMemberId },
            participantMemberIds: [assignee.id],
          });
          return notice;
        },
      };
    };
    return change(tx, writerFor(conversation));
  });
  await signalNotices(ports, posted);
  // A failed push or delivery never rolls back or misreports a committed write.
  await Promise.allSettled(
    addressed.map((notice) => publishAssignmentReceipt(ports, notice.id, notice.id)),
  );
  return result;
}

/** Post one server notice (a null sender); only a receipt mentions a member and names the Agent
 * it is delivered to. */
async function writeNotice(
  tx: Transaction,
  conversation: ConversationRef,
  input: NoticeInput,
): Promise<PostedNotice> {
  const sequence = await allocateSequence(tx, conversation.conversationId);
  // Named fields only: callers pass wider scope objects that are also a ConversationRef.
  const { conversationId, workspaceId } = conversation;
  const message = await tx.message.create({
    data: {
      id: input.id,
      conversationId,
      workspaceId,
      threadRootId: input.threadRootId,
      body: input.body,
      sequence,
      mentions: input.mentions
        ? {
            create: {
              memberId: input.mentions.id,
              workspaceId,
              kind: input.mentions.agentId ? "agent" : "user",
              actorId: input.mentions.agentId ?? input.mentions.userId!,
              handle: input.mentions.agent?.name ?? input.mentions.user!.username,
            },
          }
        : undefined,
      deliveries: input.deliverTo
        ? { create: { conversationId, workspaceId, agentId: input.deliverTo, sequence } }
        : undefined,
    },
    select: {
      id: true,
      conversationId: true,
      workspaceId: true,
      sequence: true,
      threadRootId: true,
      body: true,
    },
  });
  await tx.systemMessage.create({
    data: {
      messageId: message.id,
      conversationId,
      workspaceId,
      kind: input.system.kind,
      params: input.system.params as Prisma.InputJsonObject,
    },
  });
  return message;
}

/**
 * Signal committed notices only to this conversation; they count no unread, change no
 * sidebar badge and wake/push nobody.
 */
export async function signalNotices(ports: TaskBoardPorts, notices: readonly PostedNotice[]) {
  const realtime = ports.dependencies.realtime;
  if (!realtime) return;
  await Promise.allSettled(
    notices.map((notice) =>
      Promise.resolve().then(() =>
        announceMessageBestEffort(ports.db, realtime, {
          conversationId: notice.conversationId,
          messageId: notice.id,
          sequence: notice.sequence,
          ...(notice.threadRootId && { threadRootId: notice.threadRootId }),
        }),
      ),
    ),
  );
}

/**
 * A server notice in the thread of a message a task was made from, so its author learns of it. It
 * counts no unread and wakes nobody (`signalNotices`).
 */
export function postSourceNotice(
  tx: Transaction,
  conversation: ConversationRef,
  rootId: string,
  task: { id: string; number: number; title: string },
  actor: NoticeActor,
) {
  const quoted = quotedTask(task, []);
  return writeNotice(tx, conversation, {
    threadRootId: rootId,
    body: noticeText.fromMessage(actor.displayName, quoted),
    system: {
      kind: "task.from_message",
      params: { actor, task: quoted },
    },
  });
}
