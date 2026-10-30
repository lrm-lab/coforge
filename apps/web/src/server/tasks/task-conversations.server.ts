import type { MentionSelectorInput, TaskPrincipal } from "@lrm/coforge-sdk/internal";

import { messageAnchorWhere } from "#src/server/db/message-anchor.server";
import { readAgentMessagePage } from "#src/server/db/repositories/agent-message-history.repositories.server";
import type { AgentMessagesPage } from "#src/server/agents/agent-messages.server";

import { AppError } from "#src/lib/app-error";
import { ACTIVE_MEMBER_WHERE } from "#src/server/conversations/active-member.server";
import type { MessageRequestIdempotency } from "#src/server/conversations/message-request-idempotency.server";
import { lockConversation } from "#src/server/conversations/conversation-lock.server";
import { allocateSequence } from "#src/server/db/repositories/sequence-allocation.server";
import type { Transaction, TaskBoardPorts } from "./task-board-ports.server";
import { publishTaskConversationMessage } from "./task-publication.server";
import { markHumanRead } from "#src/server/conversations/human-unread.server";
import { postTaskMessage } from "./task-discussion-send.server";
import {
  discussionOf,
  followTask,
  joinDiscussion,
  type TaskFollowReason,
} from "./task-discussion-store.server";
import { resolveTaskScope } from "./task-scope.server";
import { TASK_SCOPE_WHERE, taskSelection, taskView } from "./task-view.server";

/** Names a task by the board it is on (`target`, an Agent's `#channel`, or `conversationId`, a
 * person's page) and its number. */
export type TaskConversationRef = { target?: string; conversationId?: string; number: number };

export { TASK_FOLLOW_REASONS, type TaskFollowReason } from "./task-discussion-store.server";

const MAX_VIEW_MESSAGES = 20;

/**
 * A task's own conversation (`Conversation.kind` "task_thread"), made by its first reply, and who
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
          where: { memberId_taskId: { memberId: member.id, taskId: task.id } },
          select: { reason: true },
        })
      : null;
    return { following: follow !== null };
  }

  async view(principal: TaskPrincipal, ref: TaskConversationRef, options: { limit?: number }) {
    const { task, member, boardName } = await this.resolve(principal, ref);
    const limit = Math.min(Math.max(options.limit ?? 5, 1), MAX_VIEW_MESSAGES);
    const [full, follow, discussion] = await Promise.all([
      this.ports.db.task.findUniqueOrThrow({ where: { id: task.id }, select: taskSelection }),
      member
        ? this.ports.db.taskFollow.findUnique({
            where: { memberId_taskId: { memberId: member.id, taskId: task.id } },
            select: { reason: true },
          })
        : null,
      task.discussionConversationId
        ? this.discussionPage(task.discussionConversationId, limit)
        : null,
    ]);
    return {
      taskRef: `${boardName}:#${task.number}`,
      task: taskView(full, "agent"),
      sourceMessage: await this.sourceMessage(full),
      following: follow !== null,
      followReason: follow?.reason ?? null,
      conversation: { exists: discussion !== null, replyCount: discussion?.total ?? 0 },
      recentMessages: discussion?.messages ?? [],
      hasOlder: discussion ? discussion.total > discussion.messages.length : false,
    };
  }

  /**
   * Posts a reply, making the conversation if this is the first. The replier follows the task; the
   * task's other followers' Agents are delivered the reply.
   */
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
          member: member!,
          body,
          attachmentIds: input.attachmentIds,
          mentions: input.mentions,
        }),
      );
      // After the commit, and only for the first of a retried reply; a failed push is replayed.
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

  /**
   * The conversation as an Agent reads it: the same pages, anchors and read position as a message
   * read, over the task's own conversation. An Agent that follows the task takes a bookkeeping seat
   * there, as for attachment comments; the seat is never authority, the board's channel is.
   */
  async read(principal: TaskPrincipal, ref: TaskConversationRef, page: AgentMessagesPage) {
    if (!principal.agentId) throw new AppError("ACCESS_DENIED");
    const agentId = principal.agentId;
    const { task, boardName } = await this.resolve(principal, ref, { member: true });
    if (!task.discussionConversationId)
      return { messages: [], hasOlder: false, hasNewer: false, modelSeenUpToSeq: null };
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
      canonicalTarget: `${boardName}:#${task.number}`,
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
    const created = await followTask(this.ports.db, scope, task.id, member!.id, "manual");
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

  /** `reason` is for the notice in the conversation that someone stopped following (not yet shown). */
  async unfollow(principal: TaskPrincipal, ref: TaskConversationRef, _reason?: string) {
    const { task, member, boardName } = await this.resolve(principal, ref, { member: true });
    const removed = await this.ports.db.taskFollow.deleteMany({
      where: { taskId: task.id, memberId: member!.id },
    });
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
        task: { conversation: TASK_SCOPE_WHERE },
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
    const task = await this.ports.db.task.findUnique({
      where: {
        conversationId_number: { conversationId: scope.conversationId, number: ref.number },
      },
      select: {
        id: true,
        number: true,
        title: true,
        status: true,
        discussionConversationId: true,
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

  /** The channel message a task was made from, as the reader sees it in the board. */
  private async sourceMessage(task: { sourceMessageId: string | null; conversationId: string }) {
    if (!task.sourceMessageId) return null;
    const message = await this.ports.db.message.findFirst({
      where: { id: task.sourceMessageId, conversationId: task.conversationId },
      select: {
        id: true,
        body: true,
        createdAt: true,
        sender: {
          select: { user: { select: { username: true } }, agent: { select: { name: true } } },
        },
      },
    });
    return message
      ? {
          id: message.id,
          content: message.body,
          createdAt: message.createdAt.toISOString(),
          senderName: message.sender?.agent?.name ?? message.sender?.user?.username ?? null,
        }
      : null;
  }

  /** The task's conversation, made now if the task has none. */
  private async discussionPage(conversationId: string, limit: number) {
    const [total, rows] = await Promise.all([
      this.ports.db.message.count({ where: { conversationId } }),
      this.ports.db.message.findMany({
        where: { conversationId },
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
    return {
      total,
      messages: rows.reverse().map((row) => ({
        id: row.id,
        sequence: row.sequence,
        body: row.body,
        createdAt: row.createdAt.toISOString(),
        sender: row.sender?.agent?.name ?? row.sender?.user?.username ?? null,
      })),
    };
  }
}

/** `#channel`, or `dm:@peer` for a task on a direct board. */
function boardLabel(channelName: string | null, peer?: string | null) {
  return channelName ? `#${channelName}` : `dm:@${peer ?? "?"}`;
}

/**
 * A server notice in a task's conversation (an assignment, a follower leaving): no sender, made
 * with the conversation if the task has none yet, delivered to `deliverToAgentId` when it names
 * one. The caller holds the board's lock.
 */
export async function postTaskNotice(
  tx: Transaction,
  scope: { conversationId: string; workspaceId: string },
  taskId: string,
  notice: { id?: string; body: string; deliverToAgentId?: string | null },
) {
  const task = await tx.task.findUniqueOrThrow({
    where: { id: taskId },
    select: { id: true, discussionConversationId: true },
  });
  const conversationId =
    task.discussionConversationId ??
    (await (async () => {
      const conversation = await tx.conversation.create({
        data: { workspaceId: scope.workspaceId, kind: "task_thread" },
        select: { id: true },
      });
      await tx.task.update({
        where: { id: taskId },
        data: { discussionConversationId: conversation.id },
      });
      return conversation.id;
    })());
  await lockConversation(tx, conversationId);
  const sequence = await allocateSequence(tx, conversationId);
  return tx.message.create({
    data: {
      id: notice.id,
      workspaceId: scope.workspaceId,
      conversationId,
      body: notice.body,
      sequence,
      deliveries: notice.deliverToAgentId
        ? {
            create: [
              {
                workspaceId: scope.workspaceId,
                conversationId,
                agentId: notice.deliverToAgentId,
                sequence,
              },
            ],
          }
        : undefined,
    },
    select: { id: true, sequence: true, conversationId: true, workspaceId: true, body: true },
  });
}
