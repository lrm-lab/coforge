import { lockConversation } from "#src/server/conversations/conversation-lock.server";
import { quotedTask, type QuotedTask } from "./task-notices.server";
import type {
  Transaction,
  TaskBoardPorts,
  Member,
  Assignee,
  ConversationRef,
} from "./task-board-ports.server";

type PostedNotice = ConversationRef & {
  id: string;
  sequence: number;
  threadRootId: string | null;
  body: string;
};
type NoticeInput = {
  id?: string;
  threadRootId?: string;
  body: string;
  deliverTo?: string | null;
  /** The member the notice personally mentions: its one mention row. */
  mentions?: Assignee;
};
/** The Task fields a notice quotes; `messageId` is also the root of the Task's thread. */
type NoticeSubject = { messageId: string; number: number; title: string };
/**
 * Write notices under the withNotices conversation lock; signal after commit. Assignment
 * receipts are delivered/pushed separately by the caller through publishAssignmentReceipt.
 */
type NoticeWriter = {
  /** The Tasks as notices quote them: clean titles, in the given order. */
  quote(tasks: readonly NoticeSubject[]): Promise<QuotedTask[]>;
  /** A top-level notice in the conversation; `id` fixes it, for a notice written at most once. */
  inConversation(body: string, id?: string): Promise<PostedNotice>;
  /** A reply in the Task's own thread. */
  inThread(task: NoticeSubject, body: (task: QuotedTask) => string): Promise<PostedNotice>;
  /**
   * Fixed-id receipt with an assignee mention (overrides human mute) and one delivery to an
   * Agent assignee other than the actor. Self-assigned Agents already hold it in the result.
   * The body is server-built @handle text.
   */
  receipt(input: {
    id: string;
    body: string;
    assignee: Assignee;
    actor: Member;
  }): Promise<PostedNotice>;
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
  const result = await ports.db.$transaction(async (tx) => {
    await lockConversation(tx, conversation.conversationId);
    const post = (input: NoticeInput) => writeNotice(tx, conversation, input);
    const postAndSignal = async (input: NoticeInput) => {
      const notice = await post(input);
      posted.push(notice);
      return notice;
    };
    const quote = async (tasks: readonly NoticeSubject[]) => {
      const mentions = await tx.messageMention.findMany({
        where: { messageId: { in: tasks.map((task) => task.messageId) } },
        select: { messageId: true, kind: true, actorId: true, handle: true },
      });
      return tasks.map((task) =>
        quotedTask(
          task,
          mentions.filter((mention) => mention.messageId === task.messageId),
        ),
      );
    };
    return change(tx, {
      quote,
      inConversation: (body, id) => postAndSignal({ body, id }),
      inThread: async (task, body) => {
        const [quoted] = await quote([task]);
        return postAndSignal({ body: body(quoted!), threadRootId: task.messageId });
      },
      receipt: ({ assignee, actor, ...input }) =>
        post({
          ...input,
          deliverTo: assignee.id === actor.id ? null : assignee.agentId,
          mentions: assignee,
        }),
    });
  });
  await signalNotices(ports, posted);
  return result;
}

/** Post one server notice (a null sender); only a receipt mentions a member and names the Agent
 * it is delivered to. */
async function writeNotice(
  tx: Transaction,
  conversation: ConversationRef,
  input: NoticeInput,
): Promise<PostedNotice> {
  const latest = await tx.message.findFirst({
    where: { conversationId: conversation.conversationId },
    orderBy: { sequence: "desc" },
    select: { sequence: true },
  });
  const sequence = (latest?.sequence ?? 0) + 1;
  // Named fields only: callers pass wider scope objects that are also a ConversationRef.
  const { conversationId, workspaceId } = conversation;
  return tx.message.create({
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
}

/**
 * Signal committed notices only to this conversation; they count no unread, change no
 * sidebar badge and wake/push nobody.
 */
async function signalNotices(ports: TaskBoardPorts, notices: readonly PostedNotice[]) {
  const realtime = ports.dependencies.realtime;
  if (!realtime) return;
  await Promise.allSettled(
    notices.map((notice) =>
      Promise.resolve().then(() =>
        realtime.messageAvailable({
          conversationId: notice.conversationId,
          messageId: notice.id,
          sequence: notice.sequence,
          ...(notice.threadRootId && { threadRootId: notice.threadRootId }),
        }),
      ),
    ),
  );
}
