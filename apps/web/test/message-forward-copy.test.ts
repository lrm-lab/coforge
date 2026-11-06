import { expect, test } from "bun:test";
import { MessageForwards } from "#src/server/conversations/message-forwards.server";

const file = (objectKey: string) => ({
  objectKey,
  fileName: `${objectKey}.txt`,
  contentType: "text/plain",
  sizeBytes: 1,
});
/** Two originals, a selection: the first with one upload, the second with two. */
const forwardSources = [
  { attachments: [file("source-a")] },
  { attachments: [file("source-b"), file("source-c")] },
];

test("forward attachment copies run concurrently, each original keeping its own copies in order", async () => {
  let active = 0;
  let maximum = 0;
  const copied: string[] = [];
  const storage = {
    copyObject: async (from: string) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await Promise.resolve();
      copied.push(from);
      active -= 1;
    },
    removeMany: async () => {},
  };
  const db = { attachment: { create: async () => ({}) } };
  const forwards = new MessageForwards({ db, storage: async () => storage } as never);
  const result = await (
    forwards as unknown as {
      copyAttachments(
        sources: typeof forwardSources,
        scope: { workspaceId: string; userId: string; destination: string },
      ): Promise<{ bySource: string[][] }>;
    }
  ).copyAttachments(forwardSources, { workspaceId: "w", userId: "u", destination: "d" });

  expect(maximum).toBe(3);
  expect(copied).toHaveLength(3);
  expect(result.bySource.map((ids) => ids.length)).toEqual([1, 2]);
});

test("a copy failure waits for siblings before cleaning copied rows and objects", async () => {
  const removedObjects: string[] = [];
  let deletedIds: string[] = [];
  const storage = {
    copyObject: async (from: string) => {
      await Promise.resolve();
      if (from === "source-b") throw new Error("copy failed");
    },
    removeMany: async (keys: readonly string[]) => {
      removedObjects.push(...keys);
    },
  };
  const db = {
    attachment: {
      create: async () => ({}),
      deleteMany: async ({ where }: { where: { id: { in: string[] } } }) => {
        deletedIds = where.id.in;
      },
    },
  };
  const forwards = new MessageForwards({ db, storage: async () => storage } as never);

  await expect(
    (
      forwards as unknown as {
        copyAttachments(
          sources: typeof forwardSources,
          scope: { workspaceId: string; userId: string; destination: string },
        ): Promise<unknown>;
      }
    ).copyAttachments(forwardSources, { workspaceId: "w", userId: "u", destination: "d" }),
  ).rejects.toThrow("copy failed");

  // source-a and source-c were copied before source-b's failure was seen: both go.
  expect(deletedIds).toHaveLength(2);
  expect(removedObjects).toHaveLength(2);
});
