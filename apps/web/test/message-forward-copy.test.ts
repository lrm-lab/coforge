import { expect, test } from "bun:test";
import { MessageForwards } from "#src/server/conversations/message-forwards.server";

const forwardSource = {
  attachments: [
    { objectKey: "source-a", fileName: "a.txt", contentType: "text/plain", sizeBytes: 1 },
    { objectKey: "source-b", fileName: "b.txt", contentType: "text/plain", sizeBytes: 1 },
  ],
};

test("forward attachment copies run concurrently while preserving source order", async () => {
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
        source: typeof forwardSource,
        scope: { workspaceId: string; userId: string; destination: string },
      ): Promise<{ ids: string[] }>;
    }
  ).copyAttachments(forwardSource, { workspaceId: "w", userId: "u", destination: "d" });

  expect(maximum).toBe(2);
  expect(copied).toHaveLength(2);
  expect(result.ids).toHaveLength(2);
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
          source: typeof forwardSource,
          scope: { workspaceId: string; userId: string; destination: string },
        ): Promise<unknown>;
      }
    ).copyAttachments(forwardSource, { workspaceId: "w", userId: "u", destination: "d" }),
  ).rejects.toThrow("copy failed");

  expect(deletedIds).toHaveLength(1);
  expect(removedObjects).toHaveLength(1);
});
