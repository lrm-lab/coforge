import type { TaskLabel } from "@lrm/coforge-sdk/internal";
import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import { assertCanManageWorkspaceSettings } from "#src/server/workspaces/member-role.server";
import { workspaceMemberRole } from "#src/server/workspaces/workspace-membership.server";

import { LABEL_GROUP_SELECT } from "./label-groups.server";

const MERGE_SELECT = { id: true, groupId: true, group: { select: LABEL_GROUP_SELECT } } as const;

export async function mergeLabels(
  db: PrismaClient,
  workspaceId: string,
  userId: string,
  fromId: string,
  intoId: string,
): Promise<{ moved: number; dropped: number }> {
  assertCanManageWorkspaceSettings(await workspaceMemberRole(db, workspaceId, userId));
  if (fromId === intoId) throw new AppError("INVALID_INPUT");
  const labels = await db.label.findMany({
    where: { workspaceId, id: { in: [fromId, intoId] } },
    select: MERGE_SELECT,
  });
  const from = labels.find((label) => label.id === fromId);
  const into = labels.find((label) => label.id === intoId);
  if (!from || !into) throw new AppError("NOT_FOUND");
  return db.$transaction(async (tx) => {
    const carried = await tx.taskLabel.findMany({
      where: { labelId: fromId },
      select: { taskId: true },
    });
    const taskIds = carried.map(({ taskId }) => taskId);
    const existingInto = taskIds.length
      ? await tx.taskLabel.findMany({
          where: { taskId: { in: taskIds }, labelId: intoId },
          select: { taskId: true },
        })
      : [];
    const existingIntoTaskIds = new Set(existingInto.map(({ taskId }) => taskId));
    const clashes =
      taskIds.length && into.groupId && into.group?.selection === "single"
        ? await tx.taskLabel.findMany({
            where: {
              taskId: { in: taskIds },
              labelId: { notIn: [intoId, fromId] },
              label: { groupId: into.groupId },
            },
            select: { taskId: true, label: { select: { id: true, name: true, color: true } } },
          })
        : [];
    const clashByTask = new Map<string, TaskLabel>();
    for (const clash of clashes)
      if (!clashByTask.has(clash.taskId)) clashByTask.set(clash.taskId, clash.label);

    const dropExistingIds: string[] = [];
    const moveTaskIds: string[] = [];
    const clashEntries: Array<{ taskId: string; label: TaskLabel }> = [];
    for (const { taskId } of carried) {
      if (existingIntoTaskIds.has(taskId)) {
        dropExistingIds.push(taskId);
        continue;
      }
      const clash = clashByTask.get(taskId);
      if (clash) clashEntries.push({ taskId, label: clash });
      moveTaskIds.push(taskId);
    }

    if (dropExistingIds.length > 0) {
      await tx.taskLabel.deleteMany({
        where: { labelId: fromId, taskId: { in: dropExistingIds } },
      });
    }
    if (clashEntries.length > 0) {
      clashEntries.sort(
        (a, b) => a.taskId.localeCompare(b.taskId) || a.label.id.localeCompare(b.label.id),
      );
      if (clashEntries.length === 1) {
        const only = clashEntries[0]!;
        await tx.taskLabel.delete({
          where: { taskId_labelId: { taskId: only.taskId, labelId: only.label.id } },
        });
      } else {
        await tx.$executeRaw`DELETE FROM "task_labels" AS tl
          USING unnest(
            ${clashEntries.map((entry) => entry.taskId)}::uuid[],
            ${clashEntries.map((entry) => entry.label.id)}::uuid[]
          ) AS v("taskId", "labelId")
          WHERE tl."taskId" = v."taskId" AND tl."labelId" = v."labelId"`;
      }
      await recordMergeRemovals(tx, clashEntries);
    }
    if (moveTaskIds.length > 0) {
      await tx.taskLabel.updateMany({
        where: { labelId: fromId, taskId: { in: moveTaskIds } },
        data: { labelId: intoId },
      });
    }
    await tx.label.delete({ where: { id: fromId } });
    return { moved: moveTaskIds.length, dropped: dropExistingIds.length + clashEntries.length };
  });
}

async function recordMergeRemovals(
  tx: Prisma.TransactionClient,
  entries: readonly { taskId: string; label: TaskLabel }[],
): Promise<void> {
  const latestByTask = await tx.taskHistoryEvent.groupBy({
    by: ["taskId"],
    where: { taskId: { in: entries.map((entry) => entry.taskId) } },
    _max: { seq: true },
  });
  const maxSeq = new Map(latestByTask.map((row) => [row.taskId, row._max.seq ?? 0]));
  await tx.taskHistoryEvent.createMany({
    data: entries.map(({ taskId, label }) => ({
      taskId,
      seq: (maxSeq.get(taskId) ?? 0) + 1,
      eventType: "labels_changed",
      actorType: "system",
      actorName: null,
      payload: { added: [], removed: [label] },
    })),
  });
}
