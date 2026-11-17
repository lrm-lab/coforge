import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { TaskBoard } from "#src/server/tasks/task-board.server";

/** A message is found by its eight-character id, never ambiguously. */

test("converting by an eight-character message id finds only that channel's top-level message, in any case, and refuses an ambiguous one", async () => {
  const connectionString = Bun.env.TASK_TEST_DATABASE_URL;
  if (!connectionString) throw new Error("TASK_TEST_DATABASE_URL must point to local PostgreSQL");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const suffix = crypto.randomUUID().slice(0, 8);
  const human = await db.user.create({
    data: { displayName: `short-id-${suffix}`, username: `short-id-${suffix}` },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: `task-short-id-${suffix}`,
      name: "Task short ids",
      members: { create: { userId: human.id, role: "owner" } },
    },
  });
  try {
    const [channel, other] = await Promise.all(
      ["work", "other"].map((name) =>
        db.conversation.create({
          data: {
            workspaceId: workspace.id,
            channelName: `${name}-${suffix}`,
            members: { create: { userId: human.id } },
          },
          include: { members: true },
        }),
      ),
    );
    // Ids that share a first eight characters, built so each prefix below names a known set.
    const id = (prefix: string, tail: string) =>
      `${prefix}-0000-4000-8000-${tail.padStart(12, "0")}`;
    const post = (
      conversation: typeof channel,
      messageId: string,
      sequence: number,
      threadRootId?: string,
    ) =>
      db.message.create({
        data: {
          id: messageId,
          workspaceId: workspace.id,
          conversationId: conversation!.id,
          senderMemberId: conversation!.members[0]!.id,
          sequence,
          body: `Message ${sequence}`,
          threadRootId,
        },
      });
    const unique = await post(channel, id("abcdef01", "1"), 1);
    // The same prefix as a reply here and as a top-level message elsewhere names nothing extra.
    await post(channel, id("abcdef01", "2"), 2, unique.id);
    await post(other, id("abcdef01", "3"), 1);
    await post(channel, id("abcdef02", "1"), 3);
    await post(channel, id("abcdef02", "2"), 4);

    const board = new TaskBoard(db);
    const convert = (messageId: string) =>
      board.execute(
        { workspaceId: workspace.id, userId: human.id },
        {
          operation: "convert",
          idempotencyKey: crypto.randomUUID(),
          conversationId: channel!.id,
          messageId,
        },
      );
    expect((await convert("ABCDEF01")).tasks[0]).toMatchObject({ sourceMessageId: unique.id });
    await expect(convert("abcdef02")).rejects.toThrow("CONFLICT");
    await expect(convert("abcdef03")).rejects.toThrow("NOT_FOUND");
  } finally {
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.user.delete({ where: { id: human.id } });
    await db.$disconnect();
  }
});
