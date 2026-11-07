import { expect, test } from "bun:test";
import { mergeLabels } from "./label-merge.server";

test("merges carried labels from batched read shapes", async () => {
  const updates: { taskId: string; labelId: string }[] = [];
  const deletes: string[] = [];
  const histories: string[] = [];
  const db = {
    workspaceMembership: { findUnique: async () => ({ role: "owner" }) },
    label: {
      findMany: async () => [
        { id: "from", groupId: null, group: null },
        { id: "into", groupId: "group", group: { selection: "single" } },
      ],
    },
    $transaction: async (run: (tx: any) => Promise<unknown>) =>
      run({
        taskLabel: {
          findMany: async (args: any) =>
            args.where.labelId === "from"
              ? [{ taskId: "task-1" }, { taskId: "task-2" }]
              : args.where.labelId === "into"
                ? []
                : [{ taskId: "task-2", label: { id: "other", name: "Other", color: "blue" } }],
          delete: async ({ where }: any) => deletes.push(where.taskId_labelId.labelId),
          update: async ({ where }: any) =>
            updates.push({ taskId: where.taskId_labelId.taskId, labelId: "into" }),
        },
        taskHistoryEvent: {
          findFirst: async () => null,
          create: async ({ data }: any) => histories.push(data.taskId),
        },
        label: { delete: async () => undefined },
      }),
  } as any;

  await expect(mergeLabels(db, "workspace", "owner", "from", "into")).resolves.toEqual({
    moved: 2,
    dropped: 1,
  });
  expect(updates).toEqual([
    { taskId: "task-1", labelId: "into" },
    { taskId: "task-2", labelId: "into" },
  ]);
  expect(deletes).toEqual(["other"]);
  expect(histories).toEqual(["task-2"]);
});
