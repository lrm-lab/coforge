import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import { historyRows, taskChanges } from "./task-history.server";
import { taskSelection, type SelectedTask } from "./task-view.server";
import { assertMayEnter } from "./task-gates.server";
import { isTaskManager } from "./task-assignees.server";
import type { TaskHistoryChange, TaskWriteStatus } from "@lrm/coforge-sdk/internal";
import type { Transaction, Member } from "./task-board-ports.server";

/** The conversation's Task numbered `number`, read as `taskSelection`, or null. */
export function findTaskByNumber(
  client: Transaction | PrismaClient,
  conversationId: string,
  number: number,
) {
  // task #512: a marked Task is gone to every write; only the sweep and restore read it.
  return client.task.findFirst({
    where: { conversationId, number, deletedAt: null },
    select: taskSelection,
  });
}

/** A command that names the revision it read is refused (`CONFLICT`) once the Task moved on. */
export function assertExpectedRevision(task: { revision: number }, expectedRevision?: number) {
  if (expectedRevision !== undefined && task.revision !== expectedRevision)
    throw new AppError("CONFLICT");
}

export function withoutAssignee(task: { status: string; number: number }) {
  if (task.status === "done")
    throw new AppError("CONFLICT", {
      hint: `task #${task.number} is done; change its status before removing its owner`,
    });
  return { ownerMemberId: null, claimedAt: null };
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
  data: Omit<Prisma.TaskUncheckedUpdateManyInput, "status"> & { status?: TaskWriteStatus },
  options: {
    relationChanges?: readonly TaskHistoryChange[];
    manager?: boolean;
    statusReason?: string;
  } = {},
) {
  if (typeof data.status === "string" && data.status !== before.status)
    await assertMayEnter(
      tx,
      before,
      data.status,
      options.manager ?? (await isTaskManager(tx, before.workspaceId, actor)),
    );
  const changed = await tx.task.updateMany({
    where: { id: before.id, revision: before.revision, ...guard },
    data: { ...data, revision: { increment: 1 } },
  });
  if (changed.count !== 1) throw new AppError("CONFLICT");
  let task = await tx.task.findUniqueOrThrow({
    where: { id: before.id },
    select: taskSelection,
  });
  if (before.owner?.agentId && before.ownerMemberId !== task.ownerMemberId) {
    await tx.taskExecutionSession.updateMany({
      where: {
        taskId: task.id,
        agentId: before.owner.agentId,
        status: { in: ["starting", "running", "waiting"] },
      },
      data: { status: "cancelled", finishedAt: new Date() },
    });
  }
  if (task.status === "done" || task.status === "closed") {
    await tx.taskExecutionSession.updateMany({
      where: {
        taskId: task.id,
        status: { in: ["starting", "running", "waiting"] },
      },
      data: { status: "completed", finishedAt: new Date() },
    });
  }
  const enteringInProgress = before.status !== "in_progress" && task.status === "in_progress";
  if (
    task.owner?.agentId &&
    task.status === "in_progress" &&
    (task.ownerMemberId !== before.ownerMemberId || enteringInProgress)
  ) {
    await ensureTaskExecutionSession(tx, task, task.owner.agentId);
    task = await tx.task.findUniqueOrThrow({
      where: { id: before.id },
      select: taskSelection,
    });
  }
  const changes = [
    ...taskChanges(before, task, { statusReason: options.statusReason }),
    ...(options.relationChanges ?? []),
  ];
  if (!changes.length) return { task, events: [] };
  const latest = await tx.taskHistoryEvent.findFirst({
    where: { taskId: task.id },
    orderBy: { seq: "desc" },
    select: { seq: true },
  });
  const events = await tx.taskHistoryEvent.createManyAndReturn({
    data: historyRows(task.id, actor, changes, latest?.seq ?? 0),
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
    where: { taskId_agentId: { taskId: task.id, agentId } },
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
          taskId: task.id,
          conversationId: task.conversationId,
          workspaceId: task.workspaceId,
          agentId,
          status: "starting",
          attempt: 1,
        },
        select: { id: true },
      });
  return session;
}
