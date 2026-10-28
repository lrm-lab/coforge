import type { TaskCommand, TaskResult } from "@lrm/coforge-sdk/internal";
import type { PrismaClient, Prisma } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import { lockConversation } from "#src/server/conversations/conversation-lock.server";
import { ACTIVE_AGENT_WHERE } from "#src/server/agents/active-agent.server";
import { ACTIVE_MEMBER_WHERE } from "#src/server/conversations/active-member.server";
import { taskSelection, taskView, type SelectedTask } from "./task-view.server";
import {
  writeTaskExecutionEvents,
  publishTaskExecutionEvents,
} from "./task-execution-events.server";
import type { CentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import type { ConversationRealtime } from "#src/server/conversations/conversation-realtime.server";

/** Native execution observations never change business completion or another owner's attempt. */
export async function reportTaskExecution(
  db: PrismaClient,
  agentId: string,
  conversationId: string,
  command: TaskCommand,
  publisher?: Pick<CentrifugoServerApi, "publish">,
  realtime?: ConversationRealtime,
): Promise<TaskResult> {
  const report = command.executionReport!;
  const task = await db.$transaction(async (tx) => {
    await lockConversation(tx, conversationId);
    const task = await tx.task.findUnique({
      where: { conversationId_number: { conversationId, number: command.number! } },
      select: taskSelection,
    });
    if (!task) throw new AppError("NOT_FOUND");
    if (task.owner?.agentId !== agentId) throw new AppError("ACCESS_DENIED");
    if (task.status === "done" || task.status === "closed") throw new AppError("CONFLICT");
    const changed = await tx.taskExecutionSession.updateMany({
      where: {
        id: report.id,
        taskMessageId: task.messageId,
        agentId,
        attempt: report.attempt,
        requestId: { not: null },
        status: { in: ["starting", "running", "waiting"] },
      },
      data: {
        ...(report.status !== "starting" ? { status: report.status } : {}),
        ...(report.nativeSessionId ? { nativeSessionId: report.nativeSessionId } : {}),
        ...(report.status === "failed" ? { finishedAt: new Date() } : {}),
      },
    });
    if (changed.count !== 1) throw new AppError("CONFLICT");
    if (report.status === "running")
      await tx.taskExecutionSession.updateMany({
        where: { id: report.id, attempt: report.attempt, startedAt: null },
        data: { startedAt: new Date() },
      });
    if (report.status === "failed") await writeTaskExecutionEvents(tx, task, task, true);
    return task;
  });
  if (report.status === "failed")
    await publishTaskExecutionEvents(db, publisher, task, realtime).catch(() => {});
  return { tasks: [taskView(task, "agent")] };
}

type Transaction = Prisma.TransactionClient;

/**
 * Create the idempotent handoff under the Task write lock; the daemon consumes it during
 * follow-up delivery, without duplicate execution sessions from racing claims/assignments.
 */
export async function ensureTaskExecutionSession(
  tx: Transaction,
  task: SelectedTask,
  agentId: string,
) {
  const existing = await tx.taskExecutionSession.findFirst({
    where: { taskMessageId: task.messageId, agentId },
    orderBy: { attempt: "desc" },
    select: { id: true, status: true, attempt: true },
  });
  const session =
    existing && ["starting", "running", "waiting"].includes(existing.status)
      ? existing
      : await tx.taskExecutionSession.create({
          data: {
            taskMessageId: task.messageId,
            conversationId: task.conversationId,
            workspaceId: task.workspaceId,
            agentId,
            status: "starting",
            attempt: (existing?.attempt ?? 0) + 1,
          },
          select: { id: true },
        });
  await tx.agentMessageDelivery.updateMany({
    where: { messageId: task.messageId, agentId },
    data: { taskExecutionSessionId: session.id },
  });
  return session;
}

/** Only a fresh claim from a capable daemon opts in; old in-progress claims stay untouched. */
export async function enableTaskIsolation(
  tx: Transaction,
  task: SelectedTask,
  agentId: string,
  command: TaskCommand,
) {
  if (!command.isolatedExecution) return;
  const channel = await tx.conversation.findFirst({
    where: {
      id: task.conversationId,
      coordinatorAgentId: { not: null },
      coordinatorAgent: ACTIVE_AGENT_WHERE,
    },
    select: { coordinatorAgentId: true },
  });
  if (!channel) return;
  const coordinator = await tx.conversationMember.findFirst({
    where: {
      conversationId: task.conversationId,
      agentId: channel.coordinatorAgentId,
      ...ACTIVE_MEMBER_WHERE,
    },
    select: { id: true },
  });
  if (!coordinator) return;
  const session = await ensureTaskExecutionSession(tx, task, agentId);
  await tx.taskExecutionSession.update({
    where: { id: session.id },
    data: { requestId: crypto.randomUUID() },
  });
}
