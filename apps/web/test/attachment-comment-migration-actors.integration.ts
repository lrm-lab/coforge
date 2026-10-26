import { expect, test } from "bun:test";
import { Prisma } from "#src/generated/prisma/client";
import { legacyDiscussion } from "./helpers/attachment-comment-migration-fixture";

test("mapping to a left source member preserves the member's existing preferences and role", async () => {
  const f = await legacyDiscussion();
  try {
    const source = await f.db.conversationMember.update({
      where: { conversationId_userId: { conversationId: f.conversation.id, userId: f.member.id } },
      data: { leftAt: new Date("2026-10-20T00:00:00Z"), channelMuted: true, channelRole: "admin" },
    });
    const old = await f.db.message.findUniqueOrThrow({ where: { id: f.reply.id } });
    const plan = await f.migration.preflight();
    expect(plan.status).toBe("ready");
    expect(plan).toHaveProperty(
      "memberMappings",
      expect.arrayContaining([
        expect.objectContaining({
          fromMemberId: old.senderMemberId,
          conversationId: f.conversation.id,
          targetMemberId: source.id,
          createInactive: false,
        }),
      ]),
    );
    expect(await f.db.conversationMember.findUnique({ where: { id: source.id } })).toEqual(source);
  } finally {
    await f.close();
  }
});

test("a historical author and reaction actor missing from the source need one inactive seat", async () => {
  const f = await legacyDiscussion();
  try {
    const thread = await f.db.attachmentCommentThread.findUniqueOrThrow({
      where: { attachmentId: f.attachment.id },
    });
    const historical = await f.db.conversationMember.create({
      data: {
        workspaceId: f.workspace.id,
        conversationId: thread.conversationId,
        userId: f.viewer.id,
      },
    });
    await f.db.message.update({
      where: { id: f.first.id },
      data: { senderMemberId: historical.id },
    });
    await f.db.messageReaction.create({
      data: {
        workspaceId: f.workspace.id,
        conversationId: thread.conversationId,
        messageId: f.first.id,
        memberId: historical.id,
        emoji: "👍",
      },
    });
    const before = await f.db.conversationMember.count({
      where: { conversationId: f.conversation.id },
    });
    const plan = await f.migration.preflight();
    expect(plan.status).toBe("ready");
    expect(plan).toHaveProperty(
      "memberMappings",
      expect.arrayContaining([
        expect.objectContaining({
          fromMemberId: historical.id,
          conversationId: f.conversation.id,
          targetMemberId: null,
          userId: f.viewer.id,
          agentId: null,
          createInactive: true,
        }),
      ]),
    );
    expect(plan.counts).toHaveProperty("historicalSeats", 1);
    expect(plan.counts.reactions).toBe(2);
    expect(
      await f.db.conversationMember.count({ where: { conversationId: f.conversation.id } }),
    ).toBe(before);
  } finally {
    await f.close();
  }
});

test("a private read-only seat is never enrolled into the ordinary conversation", async () => {
  const f = await legacyDiscussion();
  try {
    const thread = await f.db.attachmentCommentThread.findUniqueOrThrow({
      where: { attachmentId: f.attachment.id },
    });
    const cursorOnly = await f.db.conversationMember.create({
      data: {
        workspaceId: f.workspace.id,
        conversationId: thread.conversationId,
        userId: f.viewer.id,
        readThroughSequence: 99,
      },
    });
    const plan = await f.migration.preflight();
    expect(plan.status).toBe("ready");
    expect(plan).toHaveProperty("memberMappings");
    expect(JSON.stringify(plan)).not.toContain(cursorOnly.id);
    expect(plan.counts).toHaveProperty("historicalSeats", 0);
  } finally {
    await f.close();
  }
});

test("merging available heads never reverses a file's original sequence when timestamps go backwards", async () => {
  const f = await legacyDiscussion();
  try {
    await f.db.message.update({
      where: { id: f.first.id },
      data: { createdAt: new Date("2026-10-25T10:03:00Z") },
    });
    await f.db.message.update({
      where: { id: f.reply.id },
      data: { createdAt: new Date("2026-10-25T10:00:00Z") },
    });
    const plan = await f.migration.preflight();
    expect(plan.status).toBe("ready");
    expect(plan.moves.map((row) => row.messageId)).toEqual([f.other.id, f.first.id, f.reply.id]);
  } finally {
    await f.close();
  }
});

test("an unknown dependency on a reaction row also blocks the whole plan", async () => {
  const f = await legacyDiscussion();
  const name = `migration_reaction_${crypto.randomUUID().replaceAll("-", "")}`;
  const table = Prisma.raw(`"${name}"`);
  let created = false;
  try {
    const reaction = await f.db.messageReaction.findFirstOrThrow({
      where: { messageId: f.reply.id },
    });
    await f.db.$executeRaw(Prisma.sql`CREATE TABLE ${table} (
      "messageId" uuid, "memberId" uuid, emoji text,
      FOREIGN KEY ("messageId", "memberId", emoji) REFERENCES message_reactions("messageId", "memberId", emoji)
    )`);
    created = true;
    await f.db.$executeRaw(
      Prisma.sql`INSERT INTO ${table} VALUES (${reaction.messageId}::uuid, ${reaction.memberId}::uuid, ${reaction.emoji})`,
    );
    const plan = await f.migration.preflight();
    expect(plan.status).toBe("blocked");
    expect(plan.moves).toEqual([]);
    expect(plan.blockers).toContainEqual(
      expect.objectContaining({ code: "unexpected-dependency", table: name, count: 1 }),
    );
  } finally {
    try {
      if (created) await f.db.$executeRaw(Prisma.sql`DROP TABLE ${table}`);
    } finally {
      await f.close();
    }
  }
});
