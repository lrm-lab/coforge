import type { TaskPrincipal } from "@lrm/coforge-sdk/internal";

import { messageAnchorWhere } from "#src/server/db/message-anchor.server";
import { readAgentMessagePage } from "#src/server/db/repositories/agent-message-history.repositories.server";
import type { AgentMessagesPage } from "#src/server/agents/agent-messages.server";

import { AppError } from "#src/lib/app-error";
import { ACTIVE_MEMBER_WHERE } from "#src/server/conversations/active-member.server";
import type { MessageRequestIdempotency } from "#src/server/conversations/message-request-idempotency.server";
import type { CentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import { CentrifugoConversationRealtime } from "#src/server/conversations/conversation-realtime.server";
import { lockConversation } from "#src/server/conversations/conversation-lock.server";
import type { TaskBoardPorts } from "./task-board-ports.server";
import { TaskReplyHeld } from "./task-reply-freshness.server";
import {
  reconcileTaskReply,
  writeTaskReply,
  type TaskReplyInput,
} from "./task-conversation-reply.server";
import { memberId } from "./task-board-ports.server";
import { taskDiscussionDeliveryTarget } from "./task-discussion-target.server";
import { markHumanRead } from "#src/server/conversations/human-unread.server";
import { postUnfollowNotice } from "./task-unfollow-notice.server";
import { boardLabel } from "./task-conversation-notice.server";
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

  reply(principal: TaskPrincipal, ref: TaskConversationRef, input: TaskReplyInput) {
    return this.writeReply(principal, ref, input);
  }

  async replyWithHold(
    principal: TaskPrincipal,
    ref: TaskConversationRef,
    input: TaskReplyInput,
    resume?: { taskId: string; anyway: boolean },
  ) {
    if (!principal.agentId) throw new AppError("ACCESS_DENIED");
    try {
      return await this.writeReply(principal, ref, input, {
        agentId: principal.agentId,
        resume,
      });
    } catch (error) {
      if (error instanceof TaskReplyHeld) return error.result;
      throw error;
    }
  }

  private async writeReply(
    principal: TaskPrincipal,
    ref: TaskConversationRef,
    input: TaskReplyInput,
    hold?: { agentId: string; resume?: { taskId: string; anyway: boolean } },
  ) {
    const body = input.body.trim();
    if (!body || body.length > 64_000) throw new AppError("INVALID_INPUT");
    const { task, member, scope } = await this.resolve(principal, ref, { member: true });
    if (hold?.resume && hold.resume.taskId !== task.id) throw new AppError("NOT_FOUND");
    const check = hold && !hold.resume?.anyway ? hold.agentId : undefined;
    return writeTaskReply(this.ports, this.idempotency, {
      scope,
      taskId: task.id,
      principal,
      member: { ...member!, id: memberId(member!) },
      body,
      input,
      check,
    });
  }

  async reconcileReply(principal: TaskPrincipal, ref: TaskConversationRef, idempotencyKey: string) {
    const { task, scope } = await this.resolve(principal, ref, { member: true });
    return reconcileTaskReply(
      this.idempotency,
      scope.workspaceId,
      task.id,
      principal,
      idempotencyKey,
    );
  }

  /**
   * The conversation as an Agent reads it: the same pages, anchors and read position as a message
   * read, over the task's own conversation. An Agent that follows the task takes a bookkeeping seat
   * there, as for attachment comments; the seat is never authority, the board's channel is.
   */
  async read(
    principal: TaskPrincipal,
    ref: TaskConversationRef,
    page: AgentMessagesPage,
    receiptCandidate = false,
  ) {
    if (!principal.agentId) throw new AppError("ACCESS_DENIED");
    const agentId = principal.agentId;
    const { task, member } = await this.resolve(principal, ref, { member: true });
    if (!task.discussionConversationId)
      return {
        messages: [],
        hasOlder: false,
        hasNewer: false,
        modelSeenUpToSeq: null,
        receiptCandidate: receiptCandidate ? { readThrough: 0 } : undefined,
        receiptScope: undefined,
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
    if (!receiptCandidate)
      await db.conversationMember.upsert({
        where: { conversationId_agentId: { conversationId, agentId } },
        create: { workspaceId: principal.workspaceId, conversationId, agentId },
        update: {},
      });
    const target = await taskDiscussionDeliveryTarget(
      db,
      principal.workspaceId,
      agentId,
      conversationId,
    );
    const result = await readAgentMessagePage(db, {
      workspaceId: principal.workspaceId,
      agentId,
      conversationId,
      threadRootId: null,
      // The delivery spelling is the cursor key: replayed deliveries dedupe against it.
      ...target,
      seatOptional: receiptCandidate,
      receiptCandidate,
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
    const emptyUnanchoredPage =
      result.messages.length === 0 &&
      !page.before &&
      !page.after &&
      !page.around &&
      page.fromSequence === undefined &&
      page.throughSequence === undefined;
    return {
      ...result,
      receiptScope: receiptCandidate
        ? { ...target.consumptionScope, boardMemberId: memberId(member!), taskId: task.id }
        : undefined,
      modelSeenUpToSeq: receiptCandidate
        ? null
        : (result.modelSeenUpToSeq ??
          (emptyUnanchoredPage ? (result.unreadCursorBefore ?? null) : null)),
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

  async resolveReadConfirmation(principal: TaskPrincipal, ref: TaskConversationRef) {
    const { task, member } = await this.resolve(principal, ref, { member: true });
    if (!principal.agentId || !member || !task.discussionConversationId)
      throw new AppError("NOT_FOUND");
    const target = await taskDiscussionDeliveryTarget(
      this.ports.db,
      principal.workspaceId,
      principal.agentId,
      task.discussionConversationId,
    );
    return { ...target.consumptionScope, boardMemberId: memberId(member), taskId: task.id };
  }

  async markRead(principal: TaskPrincipal, ref: TaskConversationRef, throughSequence: number) {
    if (!Number.isSafeInteger(throughSequence) || throughSequence < 1)
      throw new AppError("INVALID_INPUT");
    const { task, member } = await this.resolve(principal, ref, { member: true });
    if (!task.discussionConversationId || !member?.userId) return null;
    const moved = await markHumanRead(
      this.ports.db,
      {
        conversationId: task.discussionConversationId,
        userId: member.userId,
        throughSequence,
      },
      { recordAdvance: false },
    );
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

  async following(principal: TaskPrincipal) {
    const seat = principal.agentId ? { agentId: principal.agentId } : { userId: principal.userId };
    const rows = await this.ports.db.taskFollow.findMany({
      where: {
        workspaceId: principal.workspaceId,
        member: { ...seat, ...ACTIVE_MEMBER_WHERE },
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
                  where: {
                    userId: { not: null },
                    ...ACTIVE_MEMBER_WHERE,
                    conversation: { channelName: null },
                  },
                  select: { user: { select: { username: true } } },
                  take: 1,
                },
              },
            },
          },
        },
      },
    });
    const discussionIds = [
      ...new Set(
        rows.flatMap((row) =>
          row.task.discussionConversationId ? [row.task.discussionConversationId] : [],
        ),
      ),
    ];
    const unreadByConversation =
      principal.agentId && discussionIds.length > 0
        ? await this.unreadCounts(discussionIds, principal.agentId)
        : new Map<string, number>();
    return rows.map((row) => ({
      taskRef: `${boardLabel(row.task.conversation.channelName, row.task.conversation.members[0]?.user?.username)}:#${row.task.number}`,
      taskNumber: row.task.number,
      title: row.task.title,
      status: row.task.status,
      unread: row.task.discussionConversationId
        ? (unreadByConversation.get(row.task.discussionConversationId) ?? 0)
        : 0,
      followedAt: row.createdAt.toISOString(),
      reason: row.reason as TaskFollowReason,
    }));
  }

  private async unreadCounts(
    conversationIds: readonly string[],
    agentId: string,
  ): Promise<Map<string, number>> {
    const rows = await this.ports.db.$queryRaw<{ conversationId: string; unread: number }[]>`
      SELECT d."id"::text AS "conversationId",
             COALESCE(c."unread", 0)::int AS "unread"
      FROM unnest(${conversationIds}::uuid[]) AS d("id")
      LEFT JOIN "conversation_members" cm
        ON cm."conversationId" = d."id"
       AND cm."agentId" = ${agentId}::uuid
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS "unread"
        FROM "messages" m
        WHERE m."conversationId" = d."id"
          AND m."sequence" > COALESCE(cm."agentReadThroughSequence", 0)
          AND (cm."id" IS NULL OR m."senderMemberId" IS NULL OR m."senderMemberId" <> cm."id")
      ) c ON true`;
    return new Map(rows.map((row) => [row.conversationId, Number(row.unread)]));
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
