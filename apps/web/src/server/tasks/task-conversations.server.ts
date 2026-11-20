import type { MentionSelectorInput, TaskPrincipal } from "@lrm/coforge-sdk/internal";

import { messageAnchorWhere } from "#src/server/db/message-anchor.server";
import { readAgentMessagePage } from "#src/server/db/repositories/agent-message-history.repositories.server";
import type { AgentMessagesPage } from "#src/server/agents/agent-messages.server";

import { AppError } from "#src/lib/app-error";
import { ACTIVE_MEMBER_WHERE } from "#src/server/conversations/active-member.server";
import {
  MessageRequestInProgressError,
  type MessageRequestIdempotency,
  type MessageRequestRecords,
} from "#src/server/conversations/message-request-idempotency.server";
import type { CentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import { CentrifugoConversationRealtime } from "#src/server/conversations/conversation-realtime.server";
import { lockConversation } from "#src/server/conversations/conversation-lock.server";
import type { TaskBoardPorts } from "./task-board-ports.server";
import { memberId } from "./task-board-ports.server";
import { publishTaskConversationMessage } from "./task-publication.server";
import { taskDiscussionDeliveryTarget } from "./task-discussion-target.server";
import { markHumanRead } from "#src/server/conversations/human-unread.server";
import { postUnfollowNotice } from "./task-unfollow-notice.server";
import { boardLabel } from "./task-conversation-notice.server";
import { postTaskMessage } from "./task-discussion-send.server";
import {
  discussionOf,
  followTask,
  joinDiscussion,
  type TaskFollowReason,
} from "./task-discussion-store.server";
import { resolveTaskScope } from "./task-scope.server";
import { BROWSER_MESSAGE_MENTIONS_SELECT } from "#src/server/conversations/mentions.server";
import { LIVE_TASK_WHERE, TASK_SCOPE_WHERE, taskMentions, taskSelection } from "./task-view.server";
import { taskViewOf } from "./task-relations.server";
import {
  taskEventsForReadPage,
  taskEventsInWindow,
  taskTimelinePage,
} from "./task-timeline.server";

/** Names a task by the board it is on (`target`, an Agent's `#channel`, or `conversationId`, a
 * person's page) and its number. */
export type TaskConversationRef = { target?: string; conversationId?: string; number: number };

export { TASK_FOLLOW_REASONS, type TaskFollowReason } from "./task-discussion-store.server";

const MAX_VIEW_MESSAGES = 20;

/**
 * A task's own conversation (`Conversation.kind` "task_thread"), made with the task, and who
 * follows the task. A task is read through the board's conversation: the reader must see the
 * channel it is on, and the conversation row itself says nothing of that channel.
 */
export class TaskConversations {
  constructor(
    private readonly ports: TaskBoardPorts,
    /** Makes a retried reply (same key) answer the first one's result instead of posting twice. */
    private readonly idempotency?: MessageRequestIdempotency,
  ) {}

  /** Whether the reader follows the task: false for a task with no conversation yet, or for one
   * the reader is not a member of the board of. */
  async followState(principal: TaskPrincipal, ref: TaskConversationRef) {
    const { task, member } = await this.resolve(principal, ref);
    const follow = member
      ? await this.ports.db.taskFollow.findUnique({
          where: { memberId_taskId: { memberId: memberId(member), taskId: task.id } },
          select: { reason: true },
        })
      : null;
    return { following: follow !== null };
  }

  async view(principal: TaskPrincipal, ref: TaskConversationRef, options: { limit?: number }) {
    const { task, scope, member, boardName } = await this.resolve(principal, ref);
    const limit = Math.min(Math.max(options.limit ?? 5, 1), MAX_VIEW_MESSAGES);
    const sourceThreadRootId = task.sourceMessageId ?? task.messageId;
    const [full, follow, timeline, sourceThreadReplyCount] = await Promise.all([
      this.ports.db.task.findUniqueOrThrow({ where: { id: task.id }, select: taskSelection }),
      member
        ? this.ports.db.taskFollow.findUnique({
            where: { memberId_taskId: { memberId: memberId(member), taskId: task.id } },
            select: { reason: true },
          })
        : null,
      taskTimelinePage(this.ports.db, task, this.ports.reader, taskMentions(task), limit),
      sourceThreadRootId
        ? this.ports.db.message.count({
            where: {
              conversationId: scope.conversationId,
              threadRootId: sourceThreadRootId,
              senderMemberId: { not: null },
            },
          })
        : 0,
    ]);
    const threadBoard = boardName.startsWith("dm:@") ? boardName.slice(3) : boardName;
    const earlierDiscussion =
      sourceThreadRootId && sourceThreadReplyCount > 0
        ? {
            target: `${threadBoard}:${sourceThreadRootId.slice(0, 13)}`,
            replyCount: sourceThreadReplyCount,
          }
        : undefined;
    return {
      taskRef: `${boardName}:#${task.number}`,
      task: await taskViewOf(this.ports.db, "agent", full),
      following: follow !== null,
      followReason: follow?.reason ?? null,
      conversation: { exists: timeline.exists, replyCount: timeline.replyCount },
      ...(earlierDiscussion ? { earlierDiscussion } : {}),
      recentMessages: timeline.messages,
      recentEvents: timeline.events,
      hasOlder: timeline.hasOlder,
    };
  }

  async reply(
    principal: TaskPrincipal,
    ref: TaskConversationRef,
    input: {
      body: string;
      idempotencyKey?: string;
      attachmentIds?: readonly string[];
      mentions?: readonly MentionSelectorInput[];
    },
  ) {
    const body = input.body.trim();
    if (!body || body.length > 64_000) throw new AppError("INVALID_INPUT");
    const { task, member, scope } = await this.resolve(principal, ref, { member: true });
    const post = async () => {
      const posted = await this.ports.db.$transaction((tx) =>
        postTaskMessage(tx, {
          taskId: task.id,
          scope,
          member: { ...member!, id: memberId(member!) },
          body,
          attachmentIds: input.attachmentIds,
          mentions: input.mentions,
        }),
      );
      await publishTaskConversationMessage(this.ports, posted.messageId, posted.messageId).catch(
        () => undefined,
      );
      return {
        id: posted.messageId,
        sequence: posted.sequence,
        body: posted.body,
        createdAt: posted.createdAt,
        threadRootId: null,
        attachments: [],
        workspaceId: scope.workspaceId,
      };
    };
    const persisted =
      this.idempotency && input.idempotencyKey
        ? await this.idempotency.execute(
            {
              workspaceId: scope.workspaceId,
              senderKind: principal.agentId ? "agent" : "user",
              senderId: (principal.agentId ?? principal.userId)!,
              idempotencyKey: `task:${task.id}:${input.idempotencyKey}`,
            },
            post,
          )
        : await post();
    return { messageId: persisted.id, sequence: persisted.sequence };
  }

  async reconcileReply(principal: TaskPrincipal, ref: TaskConversationRef, idempotencyKey: string) {
    const { task, scope } = await this.resolve(principal, ref, { member: true });
    const records = this.idempotency as
      | (MessageRequestIdempotency & Partial<MessageRequestRecords>)
      | undefined;
    if (!records?.find) return { state: "not_found" as const };
    const found = await records.find({
      workspaceId: scope.workspaceId,
      senderKind: principal.agentId ? "agent" : "user",
      senderId: (principal.agentId ?? principal.userId)!,
      idempotencyKey: `task:${task.id}:${idempotencyKey}`,
    });
    if (found?.state === "processing") throw new MessageRequestInProgressError();
    if (found?.state === "completed")
      return {
        state: "committed" as const,
        messageId: found.message.id,
        sequence: found.message.sequence,
      };
    return { state: "not_found" as const };
  }

  /**
   * The conversation as an Agent reads it: the same pages, anchors and read position as a message
   * read, over the task's own conversation. An Agent that follows the task takes a bookkeeping seat
   * there, as for attachment comments; the seat is never authority, the board's channel is.
   */
  async read(principal: TaskPrincipal, ref: TaskConversationRef, page: AgentMessagesPage) {
    if (!principal.agentId) throw new AppError("ACCESS_DENIED");
    const agentId = principal.agentId;
    const { task } = await this.resolve(principal, ref, { member: true });
    if (!task.discussionConversationId)
      return {
        messages: [],
        hasOlder: false,
        hasNewer: false,
        modelSeenUpToSeq: null,
        events: await taskEventsInWindow(
          this.ports.db,
          task.id,
          this.ports.reader,
          taskMentions(task),
          {},
        ),
      };
    const conversationId = task.discussionConversationId;
    const db = this.ports.db;
    await db.conversationMember.upsert({
      where: { conversationId_agentId: { conversationId, agentId } },
      create: { workspaceId: principal.workspaceId, conversationId, agentId },
      update: {},
    });
    const result = await readAgentMessagePage(db, {
      workspaceId: principal.workspaceId,
      agentId,
      conversationId,
      threadRootId: null,
      // The delivery spelling is the cursor key: replayed deliveries dedupe against it.
      ...(await taskDiscussionDeliveryTarget(db, principal.workspaceId, agentId, conversationId)),
      isChannel: false,
      isUserAgentDirectConversation: false,
      page,
      resolveAnchor: async (value) => {
        const rows = await db.message.findMany({
          where: { conversationId, id: messageAnchorWhere(value) },
          take: 2,
          select: { id: true, sequence: true, threadRootId: true },
        });
        if (rows.length > 1) throw new AppError("INVALID_INPUT");
        if (!rows[0]) throw new AppError("NOT_FOUND");
        return rows[0];
      },
    });
    return {
      ...result,
      events: await taskEventsForReadPage(db, {
        taskId: task.id,
        conversationId,
        reader: this.ports.reader,
        mentions: taskMentions(task),
        messages: result.messages,
        hasNewer: result.hasNewer,
        ...(page.unread ? { unreadAfterSequence: result.unreadCursorBefore ?? 0 } : {}),
      }),
      messages: result.messages.map((message) => ({
        ...message,
        createdAt: message.createdAt.toISOString(),
      })),
    };
  }

  /**
   * The task's conversation, made if nobody has spoken in it yet, and the caller's seat in it: what
   * a composer needs before it can upload a file to a conversation that does not exist. Making it
   * is not a message, and follows nothing.
   */
  async open(principal: TaskPrincipal, ref: TaskConversationRef) {
    const { task, member, scope } = await this.resolve(principal, ref, { member: true });
    const conversationId = await this.ports.db.$transaction(async (tx) => {
      await lockConversation(tx, scope.conversationId);
      const id = await discussionOf(tx, task, scope.workspaceId);
      await lockConversation(tx, id);
      await joinDiscussion(tx, scope.workspaceId, id, member!);
      return id;
    });
    return { conversationId };
  }

  /**
   * Moves a person's read position in the task's conversation, as `markHumanRead` does anywhere:
   * monotone, clamped to the newest message. Nothing is announced to the sidebar; the conversation
   * is hidden. Where it left them, or null when nothing moved or there is no conversation yet.
   */
  async markRead(principal: TaskPrincipal, ref: TaskConversationRef, throughSequence: number) {
    if (!Number.isSafeInteger(throughSequence) || throughSequence < 1)
      throw new AppError("INVALID_INPUT");
    const { task, member } = await this.resolve(principal, ref, { member: true });
    if (!task.discussionConversationId || !member?.userId) return null;
    const moved = await markHumanRead(this.ports.db, {
      conversationId: task.discussionConversationId,
      userId: member.userId,
      throughSequence,
    });
    return moved ? { unreadCount: moved.unreadCount } : null;
  }

  async follow(principal: TaskPrincipal, ref: TaskConversationRef) {
    const { task, member, scope, boardName } = await this.resolve(principal, ref, { member: true });
    const created = await followTask(this.ports.db, scope, task.id, memberId(member!), "manual");
    // A person's seat is what their Activity lists: a conversation already under way is read
    // from here on, not from its first message.
    if (member!.userId && task.discussionConversationId) {
      const latest = await this.ports.db.message.findFirst({
        where: { conversationId: task.discussionConversationId },
        orderBy: { sequence: "desc" },
        select: { sequence: true },
      });
      await joinDiscussion(
        this.ports.db,
        scope.workspaceId,
        task.discussionConversationId,
        member!,
        latest?.sequence ?? 0,
      );
    }
    return { taskRef: `${boardName}:#${task.number}`, following: true, changed: created };
  }

  /** `reason` is shown in the notice that someone stopped following (`task-unfollow-notice`). */
  async unfollow(principal: TaskPrincipal, ref: TaskConversationRef, reason?: string) {
    const { task, member, scope, boardName } = await this.resolve(principal, ref, {
      member: true,
    });
    const removed = await this.ports.db.taskFollow.deleteMany({
      where: { taskId: task.id, memberId: memberId(member!) },
    });
    if (removed.count > 0)
      await postUnfollowNotice(this.ports, scope, task, memberId(member!), reason).catch(
        () => undefined,
      );
    return {
      taskRef: `${boardName}:#${task.number}`,
      following: false,
      changed: removed.count > 0,
    };
  }

  /** The task conversations the principal follows, newest follow first. */
  async following(principal: TaskPrincipal) {
    const seat = principal.agentId ? { agentId: principal.agentId } : { userId: principal.userId };
    const rows = await this.ports.db.taskFollow.findMany({
      where: {
        workspaceId: principal.workspaceId,
        member: { ...seat, ...ACTIVE_MEMBER_WHERE },
        // The same scope every other read applies: a hidden channel's tasks are not listed.
        task: { conversation: TASK_SCOPE_WHERE, ...LIVE_TASK_WHERE },
      },
      orderBy: { createdAt: "desc" },
      select: {
        reason: true,
        createdAt: true,
        task: {
          select: {
            number: true,
            title: true,
            status: true,
            discussionConversationId: true,
            conversation: {
              select: {
                channelName: true,
                members: {
                  where: { userId: { not: null }, ...ACTIVE_MEMBER_WHERE },
                  select: { user: { select: { username: true } } },
                  take: 1,
                },
              },
            },
          },
        },
      },
    });
    return Promise.all(
      rows.map(async (row) => ({
        taskRef: `${boardLabel(row.task.conversation.channelName, row.task.conversation.members[0]?.user?.username)}:#${row.task.number}`,
        taskNumber: row.task.number,
        title: row.task.title,
        status: row.task.status,
        unread: await this.unread(row.task.discussionConversationId, principal),
        followedAt: row.createdAt.toISOString(),
        reason: row.reason as TaskFollowReason,
      })),
    );
  }

  /** What others wrote in the task's conversation past this Agent's read position. */
  private async unread(conversationId: string | null, principal: TaskPrincipal) {
    if (!conversationId || !principal.agentId) return 0;
    const seat = await this.ports.db.conversationMember.findUnique({
      where: { conversationId_agentId: { conversationId, agentId: principal.agentId } },
      select: { id: true, agentReadThroughSequence: true },
    });
    return this.ports.db.message.count({
      where: {
        conversationId,
        sequence: { gt: seat?.agentReadThroughSequence ?? 0 },
        ...(seat ? { OR: [{ senderMemberId: null }, { senderMemberId: { not: seat.id } }] } : {}),
      },
    });
  }

  private async resolve(
    principal: TaskPrincipal,
    ref: TaskConversationRef,
    require: { member?: boolean } = {},
  ) {
    const scope = await resolveTaskScope(this.ports, principal, {
      operation: "list",
      idempotencyKey: crypto.randomUUID(),
      ...(ref.target ? { target: ref.target } : { conversationId: ref.conversationId }),
    });
    if (!scope.member && !(scope.channel && !require.member)) throw new AppError("NOT_FOUND");
    const task = await this.ports.db.task.findFirst({
      where: {
        conversationId: scope.conversationId,
        number: ref.number,
        ...LIVE_TASK_WHERE,
      },
      select: {
        id: true,
        number: true,
        title: true,
        status: true,
        messageId: true,
        sourceMessageId: true,
        discussionConversationId: true,
        message: { select: { mentions: BROWSER_MESSAGE_MENTIONS_SELECT } },
      },
    });
    if (!task) throw new AppError("NOT_FOUND");
    return {
      task,
      scope,
      member: scope.member,
      boardName: boardLabel(scope.channelName, ref.target?.replace(/^@/, "")),
    };
  }
}

export { boardLabel, postTaskNotice } from "./task-conversation-notice.server";

/**
 * The task conversations an Agent's writes go through: a reply's delivery reaches the followers'
 * Agents, and `message.available.v1` the people with the task's popup open, as a person's reply
 * does (`task-conversation.functions.ts`); an unfollow's notice reaches them too.
 */
export function agentTaskConversations(
  db: TaskBoardPorts["db"],
  centrifugo: CentrifugoServerApi,
  idempotency?: MessageRequestIdempotency,
) {
  return new TaskConversations(
    {
      db,
      reader: "agent",
      dependencies: {
        publisher: centrifugo,
        realtime: new CentrifugoConversationRealtime(centrifugo),
      },
    },
    idempotency,
  );
}
