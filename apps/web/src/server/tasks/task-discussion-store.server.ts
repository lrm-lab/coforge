import { AppError } from "#src/lib/app-error";
import type { Transaction } from "./task-board-ports.server";

/** Why a member follows a task: the events that follow it for them. */
export const TASK_FOLLOW_REASONS = [
  "created",
  "claimed",
  "assigned",
  "replied",
  "mentioned",
  "manual",
] as const;
export type TaskFollowReason = (typeof TASK_FOLLOW_REASONS)[number];

/**
 * A member follows a task, whoever they are and whatever made them: creating it, claiming it,
 * being assigned it, replying in it, being mentioned in it. It is the one way a follow is written,
 * so a person who stopped following is followed again by the next such event, as an Agent is.
 * Returns whether the follow is new.
 */
export async function followTask(
  tx: Pick<Transaction, "taskFollow">,
  scope: { conversationId: string; workspaceId: string },
  taskId: string,
  memberId: string,
  reason: TaskFollowReason,
) {
  const { count } = await tx.taskFollow.createMany({
    data: [
      {
        taskId,
        memberId,
        conversationId: scope.conversationId,
        workspaceId: scope.workspaceId,
        reason,
      },
    ],
    skipDuplicates: true,
  });
  return count > 0;
}

/** The task's own conversation, made by the first message or notice that needs it. The caller
 * holds the board's lock. */
export async function discussionOf(
  tx: Transaction,
  task: { id: string; discussionConversationId: string | null },
  workspaceId: string,
) {
  if (task.discussionConversationId) return task.discussionConversationId;
  const fresh = await tx.task.findUnique({
    where: { id: task.id },
    select: { discussionConversationId: true },
  });
  if (!fresh) throw new AppError("NOT_FOUND");
  if (fresh.discussionConversationId) return fresh.discussionConversationId;
  const conversation = await tx.conversation.create({
    data: { workspaceId, kind: "task_thread" },
    select: { id: true },
  });
  await tx.task.update({
    where: { id: task.id },
    data: { discussionConversationId: conversation.id },
  });
  return conversation.id;
}

/** The member's seat in the task's conversation, taken (or taken back) by speaking in it. */
export function joinDiscussion(
  tx: Transaction,
  workspaceId: string,
  conversationId: string,
  member: { userId: string | null; agentId: string | null },
  /** Where a new seat starts reading: a person who follows a conversation already under way has
   * not missed what was said before. */
  readThroughSequence = 0,
) {
  return member.userId
    ? tx.conversationMember.upsert({
        where: { conversationId_userId: { conversationId, userId: member.userId } },
        create: { workspaceId, conversationId, userId: member.userId, readThroughSequence },
        update: { leftAt: null },
      })
    : tx.conversationMember.upsert({
        where: { conversationId_agentId: { conversationId, agentId: member.agentId! } },
        create: { workspaceId, conversationId, agentId: member.agentId! },
        update: { leftAt: null },
      });
}
