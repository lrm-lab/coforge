import { expect, test } from "bun:test";
import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import { mergeLabels } from "./label-merge.server";

test("merges carried labels and records the removal of a conflicting label", async () => {
  const clashLabel = { id: "other", name: "Other", color: "blue" };
  const updates: { taskId: string; labelId: string }[] = [];
  const deletes: { taskId: string; labelId: string }[] = [];
  const histories: Prisma.TaskHistoryEventCreateManyInput[] = [];
  const tx = {
    taskLabel: {
      findMany: async ({ where }: { where: { labelId: unknown } }) =>
        where.labelId === "from"
          ? [{ taskId: "task-1" }, { taskId: "task-2" }]
          : where.labelId === "into"
            ? []
            : [{ taskId: "task-2", label: clashLabel }],
      delete: async ({ where }: { where: { taskId_labelId: (typeof deletes)[number] } }) =>
        deletes.push(where.taskId_labelId),
      updateMany: async ({
        where,
        data,
      }: {
        where: { labelId: string; taskId: { in: string[] } };
        data: { labelId: string };
      }) => {
        expect(where.labelId).toBe("from");
        updates.push(...where.taskId.in.map((taskId) => ({ taskId, labelId: data.labelId })));
        return { count: where.taskId.in.length };
      },
    },
    taskHistoryEvent: {
      groupBy: async () => [],
      createMany: async ({ data }: { data: Prisma.TaskHistoryEventCreateManyInput[] }) => {
        histories.push(...data);
        return { count: data.length };
      },
    },
    label: { delete: async () => undefined },
  };
  const db = {
    workspaceMembership: { findUnique: async () => ({ role: "owner" }) },
    label: {
      findMany: async () => [
        { id: "from", groupId: null, group: null },
        { id: "into", groupId: "group", group: { selection: "single" } },
      ],
    },
    $transaction: async <T>(run: (client: typeof tx) => Promise<T>) => run(tx),
  } as unknown as PrismaClient;

  const result = await mergeLabels(db, "workspace", "owner", "from", "into");
  expect(result).toEqual({ moved: 2, dropped: 1 });
  expect(updates).toEqual([
    { taskId: "task-1", labelId: "into" },
    { taskId: "task-2", labelId: "into" },
  ]);
  expect(deletes).toEqual([{ taskId: "task-2", labelId: "other" }]);
  expect(histories).toEqual([
    {
      taskId: "task-2",
      seq: 1,
      eventType: "labels_changed",
      actorType: "system",
      actorName: null,
      payload: { added: [], removed: [clashLabel] },
    },
  ]);
});
