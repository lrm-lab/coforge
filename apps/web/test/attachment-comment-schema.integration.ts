import { afterAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";

const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
if (!connectionString) throw new Error("CHANNEL_TEST_DATABASE_URL is required");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
afterAll(() => db.$disconnect());

test("the migration installs both attachment comment relations", async () => {
  const [row] = await db.$queryRaw<{ threads: string | null; comments: string | null }[]>`
    SELECT to_regclass('attachment_comment_threads')::text AS threads,
           to_regclass('attachment_comments')::text AS comments
  `;
  expect(row).toEqual({ threads: "attachment_comment_threads", comments: "attachment_comments" });
});

test("comment bindings enforce attachment, Workspace, conversation and anchor consistency", async () => {
  const suffix = crypto.randomUUID();
  const owner = await db.user.create({
    data: { username: `comment-schema-${suffix}`, displayName: "Schema reviewer" },
  });
  const workspace = await db.workspace.create({
    data: { name: "Comments", slug: `comments-${suffix}` },
  });
  const foreign = await db.workspace.create({ data: { name: "Other", slug: `other-${suffix}` } });
  try {
    const original = await db.conversation.create({
      data: { workspaceId: workspace.id, channelName: "source" },
    });
    const attachment = await db.attachment.create({
      data: {
        workspaceId: workspace.id,
        conversationId: original.id,
        uploaderId: owner.id,
        objectKey: `test/${suffix}`,
        fileName: "review.txt",
        contentType: "text/plain",
        sizeBytes: 1,
      },
    });
    const conversation = await db.conversation.create({
      data: { workspaceId: workspace.id, kind: "attachment_comments" },
    });
    await db.attachmentCommentThread.create({
      data: {
        attachmentId: attachment.id,
        workspaceId: workspace.id,
        conversationId: conversation.id,
      },
    });
    const otherConversation = await db.conversation.create({
      data: { workspaceId: workspace.id, kind: "attachment_comments" },
    });
    await expect(
      Promise.resolve(
        db.attachmentCommentThread.create({
          data: {
            attachmentId: attachment.id,
            workspaceId: workspace.id,
            conversationId: otherConversation.id,
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "P2002" });
    const message = await db.message.create({
      data: {
        workspaceId: workspace.id,
        conversationId: conversation.id,
        sequence: 1,
        body: "Whole file",
      },
    });
    await db.attachmentComment.create({
      data: {
        messageId: message.id,
        workspaceId: workspace.id,
        conversationId: conversation.id,
        attachmentId: attachment.id,
      },
    });
    const otherMessage = await db.message.create({
      data: {
        workspaceId: workspace.id,
        conversationId: otherConversation.id,
        sequence: 1,
        body: "Wrong conversation",
      },
    });
    await expect(
      Promise.resolve(
        db.attachmentComment.create({
          data: {
            messageId: otherMessage.id,
            workspaceId: workspace.id,
            conversationId: conversation.id,
            attachmentId: attachment.id,
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "P2003" });
    const foreignConversation = await db.conversation.create({
      data: { workspaceId: foreign.id, kind: "attachment_comments" },
    });
    const foreignMessage = await db.message.create({
      data: {
        workspaceId: foreign.id,
        conversationId: foreignConversation.id,
        sequence: 1,
        body: "Wrong Workspace",
      },
    });
    await expect(
      Promise.resolve(
        db.attachmentComment.create({
          data: {
            messageId: foreignMessage.id,
            workspaceId: foreign.id,
            conversationId: foreignMessage.conversationId,
            attachmentId: attachment.id,
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "P2003" });
    await expect(
      Promise.resolve(
        db.attachmentComment.update({
          where: { messageId: message.id },
          data: { anchorType: "lines" },
        }),
      ),
    ).rejects.toThrow();
    await expect(
      Promise.resolve(
        db.attachmentComment.update({ where: { messageId: message.id }, data: { anchorData: {} } }),
      ),
    ).rejects.toThrow();
    await db.attachmentComment.update({
      where: { messageId: message.id },
      data: { anchorType: "lines", anchorData: { start: 1, end: 2 } },
    });
    await expect(
      Promise.resolve(
        db.attachmentComment.update({
          where: { messageId: message.id },
          data: { anchorType: "unrecognized" },
        }),
      ),
    ).rejects.toThrow();
    await expect(
      Promise.resolve(
        db.attachmentComment.update({
          where: { messageId: message.id },
          data: { anchorData: [1, 2] },
        }),
      ),
    ).rejects.toThrow();
    await expect(
      Promise.resolve(
        db.attachmentComment.update({
          where: { messageId: message.id },
          data: { anchorData: { quote: "x".repeat(5000) } },
        }),
      ),
    ).rejects.toThrow();
    await db.message.delete({ where: { id: message.id } });
    expect(await db.attachmentComment.count({ where: { attachmentId: attachment.id } })).toBe(0);
  } finally {
    await db.workspace.deleteMany({ where: { id: { in: [workspace.id, foreign.id] } } });
    await db.user.delete({ where: { id: owner.id } });
  }
});
