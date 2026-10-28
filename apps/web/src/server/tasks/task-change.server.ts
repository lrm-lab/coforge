import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import { historyRows, taskChanges } from "./task-history.server";
import { taskSelection, type SelectedTask } from "./task-view.server";
import type { Transaction, Member } from "./task-board-ports.server";

/** The conversation's Task numbered `number`, read as `taskSelection`, or null. */
export function findTaskByNumber(
  client: Transaction | PrismaClient,
  conversationId: string,
  number: number,
) {
  return client.task.findUnique({
    where: { conversationId_number: { conversationId, number } },
    select: taskSelection,
  });
}

/** A command that names the revision it read is refused (`CONFLICT`) once the Task moved on. */
export function assertExpectedRevision(task: { revision: number }, expectedRevision?: number) {
  if (expectedRevision !== undefined && task.revision !== expectedRevision)
    throw new AppError("CONFLICT");
}

/**
 * Guard the Task write by the caller's row, revision and guard; mismatch is CONFLICT.
 * The row lock also serializes history numbering.
 */
export async function commitTaskChange(
  tx: Transaction,
  actor: Member,
  before: SelectedTask,
  guard: Prisma.TaskWhereInput,
  data: Prisma.TaskUncheckedUpdateManyInput,
) {
  const changed = await tx.task.updateMany({
    where: { messageId: before.messageId, revision: before.revision, ...guard },
    data: { ...data, revision: { increment: 1 } },
  });
  if (changed.count !== 1) throw new AppError("CONFLICT");
  let task = await tx.task.findUniqueOrThrow({
    where: { messageId: before.messageId },
    select: taskSelection,
  });
  if (before.owner?.agentId && before.ownerMemberId !== task.ownerMemberId) {
    await tx.taskExecutionSession.updateMany({
      where: {
        taskMessageId: task.messageId,
        agentId: before.owner.agentId,
        status: { in: ["starting", "running", "waiting"] },
      },
      data: { status: "cancelled", finishedAt: new Date() },
    });
  }
  if (task.status === "done" || task.status === "closed") {
    await tx.taskExecutionSession.updateMany({
      where: {
        taskMessageId: task.messageId,
        status: { in: ["starting", "running", "waiting"] },
      },
      data: { status: "completed", finishedAt: new Date() },
    });
  }
  if (task.owner?.agentId && task.ownerMemberId !== before.ownerMemberId) {
    await ensureTaskExecutionSession(tx, task, task.owner.agentId);
    // Read the row again so the result names the session every later read of this Task shows
    // (a restarted session keeps its older createdAt, so patching it in could disagree).
    task = await tx.task.findUniqueOrThrow({
      where: { messageId: before.messageId },
      select: taskSelection,
    });
  }
  const changes = taskChanges(before, task);
  if (!changes.length) return { task, events: [] };
  const latest = await tx.taskHistoryEvent.findFirst({
    where: { taskMessageId: task.messageId },
    orderBy: { seq: "desc" },
    select: { seq: true },
  });
  const events = await tx.taskHistoryEvent.createManyAndReturn({
    data: historyRows(task.messageId, actor, changes, latest?.seq ?? 0),
  });
  return { task, events };
}

/**
 * Create the idempotent handoff under the Task write lock; the daemon consumes it during
 * follow-up delivery, without duplicate execution sessions from racing claims/assignments.
 */
export async function ensureTaskExecutionSession(
  tx: Transaction,
  task: SelectedTask,
  agentId: string,
) {
  const existing = await tx.taskExecutionSession.findUnique({
    where: { taskMessageId_agentId: { taskMessageId: task.messageId, agentId } },
    select: { id: true, status: true },
  });
  const session = existing
    ? await tx.taskExecutionSession.update({
        where: { id: existing.id },
        data:
          existing.status === "completed" ||
          existing.status === "failed" ||
          existing.status === "cancelled"
            ? {
                status: "starting",
                attempt: { increment: 1 },
                finishedAt: null,
                lastError: null,
              }
            : {},
        select: { id: true },
      })
    : await tx.taskExecutionSession.create({
        data: {
          taskMessageId: task.messageId,
          conversationId: task.conversationId,
          workspaceId: task.workspaceId,
          agentId,
          status: "starting",
          attempt: 1,
        },
        select: { id: true },
      });
  await tx.agentMessageDelivery.updateMany({
    where: { messageId: task.messageId, agentId },
    data: { taskExecutionSessionId: session.id },
  });
  return session;
}
