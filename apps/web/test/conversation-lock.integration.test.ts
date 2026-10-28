import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { lockConversation } from "#src/server/conversations/conversation-lock.server";

const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
if (!connectionString) throw new Error("CHANNEL_TEST_DATABASE_URL must point to local PostgreSQL");

/**
 * The conversation row lock serializes writers, but nothing it guards changes the row's key, so
 * the lock is FOR NO KEY UPDATE: a foreign-key check a concurrent write takes on the row (an
 * upload referencing the conversation) must not wait for a held send to commit.
 */
test("an attachment insert is not blocked while the conversation lock is held", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const second = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const suffix = crypto.randomUUID();
  const owner = await db.user.create({
    data: { username: `lock-owner-${suffix}`, displayName: "owner" },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: `lock-${suffix}`,
      name: "Lock test",
      members: { create: [{ userId: owner.id, role: "owner" }] },
    },
  });
  const conversation = await db.conversation.create({
    data: {
      workspaceId: workspace.id,
      channelName: "chan",
      members: { create: [{ userId: owner.id }] },
    },
  });
  // Hold the conversation lock on the first connection for the length of the test.
  let releaseLock!: () => void;
  let lockHeld!: () => void;
  const held = new Promise<void>((resolve) => {
    lockHeld = resolve;
  });
  const holdLock = db.$transaction(
    (tx) =>
      lockConversation(tx, conversation.id).then(() => {
        lockHeld();
        return new Promise<void>((release) => {
          releaseLock = release;
        });
      }),
    // Past the default 5s interactive-transaction timeout: the lock must live through the test.
    { timeout: 20_000 },
  );
  try {
    await held;
    // The insert's conversation foreign-key check takes only FOR KEY SHARE; under FOR UPDATE it
    // would wait for the lock above. Ten seconds is generous for a one-row insert.
    const inserted = await Promise.race([
      second.attachment.create({
        data: {
          workspaceId: workspace.id,
          conversationId: conversation.id,
          uploaderId: owner.id,
          objectKey: `test/lock/${suffix}`,
          fileName: "upload.txt",
          contentType: "text/plain",
          sizeBytes: 1,
        },
      }),
      new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 10_000)),
    ]);
    expect(inserted).not.toBe("blocked");
    // A second writer on the same lock still serializes behind the held one — but only while it
    // is held: after release it proceeds. Checked with a lock probe, not an assert on timing.
    const probe = second.$transaction((tx) => lockConversation(tx, conversation.id), {
      timeout: 20_000,
    });
    const probeResult = await Promise.race([
      probe.then(() => "taken"),
      new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 10_000)),
    ]);
    expect(probeResult).toBe("blocked");
    releaseLock?.();
    expect(await probe.then(() => "taken")).toBe("taken");
  } finally {
    releaseLock?.();
    await holdLock.catch(() => {});
    await db.$disconnect();
    await second.$disconnect();
  }
}, 30_000);
