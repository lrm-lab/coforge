import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { deleteExpiredMessageReads } from "#src/server/conversations/message-read-retention.server";
import { readMessageSeenBy } from "#src/server/conversations/message-seen-by.server";

/**
 * The daily sweep that drops read records older than seven days (`message_reads`). Against local
 * PostgreSQL; skipped unless `CHANNEL_TEST_DATABASE_URL` points at a local database.
 */
const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
const DAY = 86_400_000;
const NOW = new Date("2026-11-03T12:00:00.000Z");

async function setup() {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: connectionString! }) });
  const suffix = crypto.randomUUID().slice(0, 8);
  const [alice, bob] = await Promise.all(
    ["alice", "bob"].map((name) =>
      db.user.create({ data: { username: `retention-${name}-${suffix}`, displayName: name } }),
    ),
  );
  const workspace = await db.workspace.create({
    data: {
      slug: `retention-${suffix}`,
      name: "Retention",
      members: { create: [{ userId: alice!.id }, { userId: bob!.id }] },
    },
  });
  const conversation = await db.conversation.create({
    data: {
      workspaceId: workspace.id,
      directKey: `user:${alice!.id}|user:${bob!.id}`,
      members: { create: [{ userId: alice!.id }, { userId: bob!.id }] },
    },
  });
  const [aliceMember, bobMember] = await Promise.all(
    [alice!.id, bob!.id].map((userId) =>
      db.conversationMember.findFirstOrThrow({
        where: { conversationId: conversation.id, userId },
      }),
    ),
  );
  const message = await db.message.create({
    data: {
      workspaceId: workspace.id,
      conversationId: conversation.id,
      sequence: 1,
      body: "hello",
      senderMemberId: aliceMember.id,
    },
  });
  const teardown = async () => {
    await db.workspace.delete({ where: { id: workspace.id } }).catch(() => {});
    await db.user.deleteMany({ where: { id: { in: [alice!.id, bob!.id] } } }).catch(() => {});
    await db.$disconnect();
  };
  return {
    db,
    workspace,
    conversation,
    message,
    alice: alice!,
    bob: bob!,
    bobMember,
    teardown,
  };
}

test.skipIf(!connectionString)(
  "drops read records older than seven days and keeps newer ones",
  async () => {
    const { db, workspace, conversation, bobMember, teardown } = await setup();
    try {
      await db.messageRead.createMany({
        data: [
          {
            workspaceId: workspace.id,
            conversationId: conversation.id,
            memberId: bobMember.id,
            sequence: 1,
            readAt: new Date(NOW.getTime() - 8 * DAY),
          },
          {
            workspaceId: workspace.id,
            conversationId: conversation.id,
            memberId: bobMember.id,
            sequence: 2,
            readAt: new Date(NOW.getTime() - 1 * DAY),
          },
        ],
      });

      expect(await deleteExpiredMessageReads(db, NOW)).toBe(1);
      expect(
        await db.messageRead.findMany({
          where: { conversationId: conversation.id },
          select: { sequence: true },
        }),
      ).toEqual([{ sequence: 2 }]);

      // A second run finds nothing: the sweep is idempotent across instances.
      expect(await deleteExpiredMessageReads(db, NOW)).toBe(0);
    } finally {
      await teardown();
    }
  },
);

test.skipIf(!connectionString)(
  "a message whose read record was pruned still reads as seen, without a time",
  async () => {
    const { db, workspace, conversation, message, alice, bob, bobMember, teardown } = await setup();
    try {
      await db.conversationMember.update({
        where: { id: bobMember.id },
        data: { readThroughSequence: 1 },
      });
      await db.messageRead.create({
        data: {
          workspaceId: workspace.id,
          conversationId: conversation.id,
          memberId: bobMember.id,
          sequence: 1,
          readAt: new Date(NOW.getTime() - 8 * DAY),
        },
      });
      const seenBy = () =>
        readMessageSeenBy(db, {
          workspaceId: workspace.id,
          userId: alice.id,
          conversationId: conversation.id,
          messageId: message.id,
        });

      const before = await seenBy();
      expect(before.seen).toEqual([{ kind: "user", id: bob.id }]);
      expect(typeof before.seenAt).toBe("string");

      expect(await deleteExpiredMessageReads(db, NOW)).toBe(1);

      const after = await seenBy();
      expect(after.seen).toEqual([{ kind: "user", id: bob.id }]);
      expect(after.seenAt).toBeUndefined();
    } finally {
      await teardown();
    }
  },
);

test.skipIf(!connectionString)(
  "deletes in batches, so a big table is never locked at once",
  async () => {
    const { db, workspace, conversation, bobMember, teardown } = await setup();
    try {
      await db.messageRead.createMany({
        data: Array.from({ length: 5 }, (_, index) => ({
          workspaceId: workspace.id,
          conversationId: conversation.id,
          memberId: bobMember.id,
          sequence: index + 1,
          readAt: new Date(NOW.getTime() - (8 + index) * DAY),
        })),
      });

      expect(await deleteExpiredMessageReads(db, NOW, { batchSize: 2 })).toBe(5);
      expect(await db.messageRead.count({ where: { conversationId: conversation.id } })).toBe(0);
    } finally {
      await teardown();
    }
  },
);
