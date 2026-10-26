import { legacyDiscussion } from "./helpers/attachment-comment-migration-fixture";
import { Prisma } from "#src/generated/prisma/client";
import { expect, test } from "bun:test";
import { attachmentCommentsFixture } from "./helpers/attachment-comments-fixture";

if (!Bun.env.MIGRATION_TEST_DATABASE_URL || !Bun.env.CHANNEL_TEST_DATABASE_URL) {
  throw new Error("MIGRATION_TEST_DATABASE_URL and CHANNEL_TEST_DATABASE_URL are required");
}

test("preflight merges two files and nested replies into one ordinary thread without writing", async () => {
  const f = await legacyDiscussion();
  try {
    const before = await f.db.message.findMany({
      where: { workspaceId: f.workspace.id },
      orderBy: { id: "asc" },
      include: { reactions: true, attachmentComment: true },
    });
    const plan = await f.migration.preflight();
    expect(plan.status).toBe("ready");
    expect(plan.blockers).toEqual([]);
    expect(plan.counts).toMatchObject({ attachments: 2, messages: 3, reactions: 1 });
    expect(
      plan.moves.map(({ messageId, conversationId, threadRootId, sequence }) => ({
        messageId,
        conversationId,
        threadRootId,
        sequence,
      })),
    ).toEqual(
      [f.first.id, f.other.id, f.reply.id].map((messageId, index) => ({
        messageId,
        conversationId: f.conversation.id,
        threadRootId: f.message.id,
        sequence: index + 3,
      })),
    );
    expect(await f.migration.preflight()).toEqual(plan);
    expect(
      await f.db.message.findMany({
        where: { workspaceId: f.workspace.id },
        orderBy: { id: "asc" },
        include: { reactions: true, attachmentComment: true },
      }),
    ).toEqual(before);
  } finally {
    await f.close();
  }
});

test("an orphan source blocks the whole plan and reports identifiers without message text", async () => {
  const f = await legacyDiscussion();
  try {
    await f.db.attachment.update({ where: { id: f.attachment.id }, data: { messageId: null } });
    const plan = await f.migration.preflight();
    expect(plan.status).toBe("blocked");
    expect(plan.moves).toEqual([]);
    expect(plan.blockers).toContainEqual({
      code: "missing-source-message",
      attachmentId: f.attachment.id,
    });
    expect(JSON.stringify(plan.blockers)).not.toContain("An existing nested reply");
    expect(await f.db.message.findUnique({ where: { id: f.reply.id } })).toMatchObject({
      threadRootId: f.first.id,
    });
  } finally {
    await f.close();
  }
});

test("a source from another workspace blocks every move", async () => {
  const f = await legacyDiscussion();
  const other = await attachmentCommentsFixture();
  try {
    await f.db.attachment.update({
      where: { id: f.attachment.id },
      data: { messageId: other.message.id },
    });
    const plan = await f.migration.preflight();
    expect(plan.status).toBe("blocked");
    expect(plan.moves).toEqual([]);
    expect(plan.blockers).toContainEqual({
      code: "source-scope-mismatch",
      attachmentId: f.attachment.id,
    });
  } finally {
    await f.close();
    await other.close();
  }
});

test("a source whose root is itself a reply blocks the plan", async () => {
  const f = await legacyDiscussion();
  try {
    await f.db.message.update({
      where: { id: f.message.id },
      data: { threadRootId: f.existingReply.id },
    });
    const plan = await f.migration.preflight();
    expect(plan.status).toBe("blocked");
    expect(plan.moves).toEqual([]);
    expect(plan.blockers).toContainEqual({
      code: "invalid-source-root",
      attachmentId: f.attachment.id,
    });
  } finally {
    await f.close();
  }
});

test("an unbound legacy reply blocks migration rather than losing its file association", async () => {
  const f = await legacyDiscussion();
  try {
    await f.db.attachmentComment.delete({ where: { messageId: f.reply.id } });
    const plan = await f.migration.preflight();
    expect(plan.status).toBe("blocked");
    expect(plan.moves).toEqual([]);
    expect(plan.blockers).toContainEqual({
      code: "unbound-legacy-message",
      attachmentId: f.attachment.id,
    });
  } finally {
    await f.close();
  }
});

test("preflight blocks sequence overflow before any moves are exported", async () => {
  const f = await legacyDiscussion();
  try {
    await f.db.message.update({
      where: { id: f.existingReply.id },
      data: { sequence: 2_147_483_647 },
    });
    const plan = await f.migration.preflight();
    expect(plan.status).toBe("blocked");
    expect(plan.moves).toEqual([]);
    expect(plan.blockers).toContainEqual({
      code: "sequence-overflow",
      attachmentId: f.attachment.id,
    });
  } finally {
    await f.close();
  }
});

test("a file attached to an ordinary reply uses the existing top-level root", async () => {
  const f = await legacyDiscussion();
  try {
    await f.db.attachment.updateMany({
      where: { id: { in: [f.attachment.id, f.second.id] } },
      data: { messageId: f.existingReply.id },
    });
    const plan = await f.migration.preflight();
    expect(plan.status).toBe("ready");
    expect(plan.moves.map((move) => move.threadRootId)).toEqual([
      f.message.id,
      f.message.id,
      f.message.id,
    ]);
  } finally {
    await f.close();
  }
});

test("an authorless legacy comment blocks the plan without inventing an identity", async () => {
  const f = await legacyDiscussion();
  try {
    await f.db.message.update({ where: { id: f.reply.id }, data: { senderMemberId: null } });
    const plan = await f.migration.preflight();
    expect(plan.status).toBe("blocked");
    expect(plan.moves).toEqual([]);
    expect(plan.blockers).toContainEqual({
      code: "invalid-message-actor",
      attachmentId: f.attachment.id,
    });
  } finally {
    await f.close();
  }
});

test("a new foreign-key dependency blocks migration and reports only its count", async () => {
  const f = await legacyDiscussion();
  const tableName = `migration_unknown_${crypto.randomUUID().replaceAll("-", "")}`;
  const table = Prisma.raw(`"${tableName}"`);
  let created = false;
  try {
    await f.db.$executeRaw(
      Prisma.sql`CREATE TABLE ${table} ("messageId" uuid REFERENCES "messages"("id"))`,
    );
    created = true;
    await f.db.$executeRaw(Prisma.sql`INSERT INTO ${table} VALUES (${f.reply.id}::uuid)`);
    const plan = await f.migration.preflight();
    expect(plan.status).toBe("blocked");
    expect(plan.moves).toEqual([]);
    expect(plan.blockers).toContainEqual(
      expect.objectContaining({
        code: "unexpected-dependency",
        table: tableName,
        count: 1,
      }),
    );
    expect(JSON.stringify(plan.blockers)).not.toContain("An existing nested reply");
  } finally {
    try {
      if (created) await f.db.$executeRaw(Prisma.sql`DROP TABLE ${table}`);
    } finally {
      await f.close();
    }
  }
});

test("a source in another conversation of the same workspace is rejected", async () => {
  const f = await legacyDiscussion();
  try {
    const other = await f.db.conversation.create({
      data: {
        workspaceId: f.workspace.id,
        channelName: "different-source",
        members: { create: { userId: f.owner.id } },
      },
      include: { members: true },
    });
    const source = await f.db.message.create({
      data: {
        workspaceId: f.workspace.id,
        conversationId: other.id,
        senderMemberId: other.members[0]!.id,
        sequence: 1,
        body: "Different source",
      },
    });
    await f.db.attachment.update({
      where: { id: f.attachment.id },
      data: { messageId: source.id },
    });
    const plan = await f.migration.preflight();
    expect(plan.status).toBe("blocked");
    expect(plan.moves).toEqual([]);
    expect(plan.blockers).toContainEqual({
      code: "source-scope-mismatch",
      attachmentId: f.attachment.id,
    });
  } finally {
    await f.close();
  }
});

test("a special source conversation is blocked even with matching identities", async () => {
  const f = await legacyDiscussion();
  try {
    await f.db.conversation.update({
      where: { id: f.conversation.id },
      data: { kind: "app_events" },
    });
    const plan = await f.migration.preflight();
    expect(plan.status).toBe("blocked");
    expect(plan.moves).toEqual([]);
    expect(plan.blockers).toContainEqual({
      code: "invalid-source-conversation",
      attachmentId: f.attachment.id,
    });
  } finally {
    await f.close();
  }
});

test("a hidden conversation without its attachment binding blocks migration", async () => {
  const f = await legacyDiscussion();
  try {
    const orphan = await f.db.conversation.create({
      data: { workspaceId: f.workspace.id, kind: "attachment_comments" },
    });
    const plan = await f.migration.preflight();
    expect(plan.status).toBe("blocked");
    expect(plan.moves).toEqual([]);
    expect(plan.blockers).toContainEqual({
      code: "unbound-legacy-conversation",
      conversationId: orphan.id,
    });
  } finally {
    await f.close();
  }
});

test("an ordinary conversation referenced as a legacy discussion is not eligible for removal", async () => {
  const f = await legacyDiscussion();
  try {
    const old = await f.db.attachmentCommentThread.findUniqueOrThrow({
      where: { attachmentId: f.attachment.id },
    });
    await f.db.conversation.update({
      where: { id: old.conversationId },
      data: { kind: null, channelName: "ordinary-not-hidden" },
    });
    const plan = await f.migration.preflight();
    expect(plan.status).toBe("blocked");
    expect(plan.moves).toEqual([]);
    expect(plan.blockers).toContainEqual({
      code: "invalid-legacy-conversation",
      attachmentId: f.attachment.id,
    });
  } finally {
    await f.close();
  }
});
