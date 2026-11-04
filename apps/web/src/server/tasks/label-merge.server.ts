import type { TaskLabel } from "@lrm/coforge-sdk/internal";
import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import { assertCanManageWorkspaceSettings } from "#src/server/workspaces/member-role.server";
import { workspaceMemberRole } from "#src/server/workspaces/workspace-membership.server";

import { LABEL_GROUP_SELECT } from "./label-groups.server";

/** What a merge reads of the two labels: which group, and whether it allows one label only. Its
 * own select, so this module does not import labels.server.ts, which imports it. */
const MERGE_SELECT = { id: true, groupId: true, group: { select: LABEL_GROUP_SELECT } } as const;

/**
 * An owner or admin merges `from` into `into`: the Tasks carrying `from` carry `into` instead,
 * `from` disappears, and a Task that would then hold two labels of one single group keeps
 * `into` and loses the other (recorded as a system `labels_changed`). Returns what moved and
 * what was dropped, so the caller can report it.
 */
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
    let moved = 0;
    let dropped = 0;
    for (const { taskId } of carried) {
      const already = await tx.taskLabel.findUnique({
        where: { taskId_labelId: { taskId, labelId: intoId } },
        select: { taskId: true },
      });
      if (already) {
        await tx.taskLabel.delete({ where: { taskId_labelId: { taskId, labelId: fromId } } });
        dropped += 1;
        continue;
      }
      // A single group allows one label: the one already there goes, `into` takes its place.
      const clash =
        into.groupId && into.group?.selection === "single"
          ? await tx.taskLabel.findFirst({
              where: {
                taskId,
                labelId: { notIn: [intoId, fromId] },
                label: { groupId: into.groupId },
              },
              select: { label: { select: { id: true, name: true, color: true } } },
            })
          : null;
      if (clash) {
        await tx.taskLabel.delete({
          where: { taskId_labelId: { taskId, labelId: clash.label.id } },
        });
        await recordMergeRemoval(tx, taskId, clash.label);
        dropped += 1;
      }
      await tx.taskLabel.update({
        where: { taskId_labelId: { taskId, labelId: fromId } },
        data: { labelId: intoId },
      });
      moved += 1;
    }
    await tx.label.delete({ where: { id: fromId } });
    return { moved, dropped };
  });
}

/** A merge's dropped label, as a system history event on the Task it was taken off. */
async function recordMergeRemoval(
  tx: Prisma.TransactionClient,
  taskId: string,
  label: TaskLabel,
): Promise<void> {
  const latest = await tx.taskHistoryEvent.findFirst({
    where: { taskId },
    orderBy: { seq: "desc" },
    select: { seq: true },
  });
  await tx.taskHistoryEvent.create({
    data: {
      taskId,
      seq: (latest?.seq ?? 0) + 1,
      eventType: "labels_changed",
      actorType: "system",
      actorName: null,
      payload: { added: [], removed: [label] },
    },
  });
}
