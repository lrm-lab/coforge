import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { markHumanRead } from "#src/server/conversations/human-unread.server";
import { readMessageSeenBy } from "#src/server/conversations/message-seen-by.server";

/**
 * When the other side read a direct message: the row an advance writes, the five-second
 * coalescing, and the answer only its sender gets. Against local PostgreSQL; skipped unless
 * `CHANNEL_TEST_DATABASE_URL` points at a local database.
 */
const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;

async function setup() {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: connectionString! }) });
  const suffix = crypto.randomUUID().slice(0, 8);
  const [alice, bob] = await Promise.all(
    ["alice", "bob"].map((name) =>
      db.user.create({ data: { username: `read-${name}-${suffix}`, displayName: name } }),
    ),
  );
  const workspace = await db.workspace.create({
    data: {
      slug: `read-times-${suffix}`,
      name: "Read times",
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
  const message = await db.message.create({
    data: {
      workspaceId: workspace.id,
      conversationId: conversation.id,
      sequence: 1,
      body: "hello",
      senderMemberId: (
        await db.conversationMember.findFirstOrThrow({
          where: { conversationId: conversation.id, userId: alice!.id },
        })
      ).id,
    },
  });
  const teardown = async () => {
    await db.workspace.delete({ where: { id: workspace.id } }).catch(() => {});
    await db.user.deleteMany({ where: { id: { in: [alice!.id, bob!.id] } } }).catch(() => {});
    await db.$disconnect();
  };
  return { db, workspace, conversation, message, alice: alice!, bob: bob!, teardown };
}

test.skipIf(!connectionString)(
  "reading a direct message records when, and its sender is told",
  async () => {
    const { db, workspace, conversation, message, alice, bob, teardown } = await setup();
    try {
      const before = await readMessageSeenBy(db, {
        workspaceId: workspace.id,
        userId: alice.id,
        conversationId: conversation.id,
        messageId: message.id,
      });
      expect(before.seenAt).toBeUndefined();
      expect(before.seen).toEqual([]);

      await markHumanRead(db, {
        conversationId: conversation.id,
        userId: bob.id,
        throughSequence: 1,
      });

      const after = await readMessageSeenBy(db, {
        workspaceId: workspace.id,
        userId: alice.id,
        conversationId: conversation.id,
        messageId: message.id,
      });
      expect(after.seen).toEqual([{ kind: "user", id: bob.id }]);
      expect(typeof after.seenAt).toBe("string");
      expect(await db.messageRead.count({ where: { conversationId: conversation.id } })).toBe(1);
    } finally {
      await teardown();
    }
  },
);

test.skipIf(!connectionString)(
  "advances within five seconds share one row, and only the sender reads the time",
  async () => {
    const { db, workspace, conversation, message, alice, bob, teardown } = await setup();
    try {
      const second = await db.message.create({
        data: {
          workspaceId: workspace.id,
          conversationId: conversation.id,
          sequence: 2,
          body: "again",
          senderMemberId: message.senderMemberId,
        },
      });
      await markHumanRead(db, {
        conversationId: conversation.id,
        userId: bob.id,
        throughSequence: 1,
      });
      await markHumanRead(db, {
        conversationId: conversation.id,
        userId: bob.id,
        throughSequence: 2,
      });

      const rows = await db.messageRead.findMany({
        where: { conversationId: conversation.id },
        select: { sequence: true },
      });
      expect(rows).toEqual([{ sequence: 2 }]);

      // The other side is not the sender, so it is told nothing about this message.
      await expect(
        readMessageSeenBy(db, {
          workspaceId: workspace.id,
          userId: bob.id,
          conversationId: conversation.id,
          messageId: second.id,
        }),
      ).rejects.toThrow("NOT_FOUND");
      expect(alice.id).not.toBe(bob.id);
    } finally {
      await teardown();
    }
  },
);
