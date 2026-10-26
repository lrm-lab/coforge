import { expect, test } from "bun:test";
import { attachmentCommentsFixture } from "./helpers/attachment-comments-fixture";
import { ConversationHistory } from "#src/server/conversations/conversation-history.server";
import {
  AGENT_MESSAGE_INCLUDE,
  toAgentMessage,
} from "#src/server/db/repositories/direct-conversation-agent-message.server";
import { UserDirectConversations } from "#src/server/conversations/user-direct-conversations.server";

test("PostgreSQL accepts unknown or positive paired dimensions and refuses partial or nonpositive pairs", async () => {
  const f = await attachmentCommentsFixture();
  try {
    expect(
      await f.db.$queryRaw<
        { convalidated: boolean }[]
      >`SELECT convalidated FROM pg_constraint WHERE conname = 'attachments_image_dimensions_pair' AND conrelid = 'attachments'::regclass`,
    ).toEqual([{ convalidated: true }]);
    const update = async (width: number | null, height: number | null) => f.db.$executeRaw`
      UPDATE "attachments" SET "imageWidth" = ${width}, "imageHeight" = ${height}
      WHERE "id" = ${f.attachment.id}::uuid`;
    for (const [width, height] of [
      [null, null],
      [640, 360],
    ] as const)
      expect(await update(width, height)).toBe(1);
    for (const [width, height] of [
      [null, 360],
      [640, null],
      [0, 360],
      [640, 0],
      [-1, 360],
    ] as const)
      await expect(update(width, height)).rejects.toThrow();
    expect(
      await f.db.attachment.findUniqueOrThrow({
        where: { id: f.attachment.id },
        select: { imageWidth: true, imageHeight: true },
      }),
    ).toEqual({ imageWidth: 640, imageHeight: 360 });
  } finally {
    await f.close();
  }
});

test("channel history and thread reads project the stored image dimensions without storage keys", async () => {
  const f = await attachmentCommentsFixture();
  try {
    await f.db.attachment.update({
      where: { id: f.attachment.id },
      data: { contentType: "image/png", imageWidth: 640, imageHeight: 360 },
    });
    const reply = await f.db.message.create({
      data: {
        workspaceId: f.workspace.id,
        conversationId: f.conversation.id,
        senderMemberId: f.message.senderMemberId,
        sequence: 2,
        body: "image reply",
        threadRootId: f.message.id,
      },
    });
    await f.db.attachment.create({
      data: {
        workspaceId: f.workspace.id,
        conversationId: f.conversation.id,
        uploaderId: f.owner.id,
        messageId: reply.id,
        objectKey: `${f.attachment.objectKey}-reply`,
        fileName: "reply.png",
        contentType: "image/png",
        sizeBytes: 1,
        imageWidth: 240,
        imageHeight: 320,
      },
    });
    const history = new ConversationHistory(f.db);
    const page = await history.loadAround(
      f.workspace.id,
      f.owner.id,
      f.conversation.id,
      f.message.id,
    );
    expect(page.messages[0]!.attachments[0]).toMatchObject({ imageWidth: 640, imageHeight: 360 });
    expect(page.messages[0]!.attachments[0]).not.toHaveProperty("objectKey");
    const agentRow = await f.db.message.findUniqueOrThrow({
      where: { id: f.message.id },
      include: AGENT_MESSAGE_INCLUDE,
    });
    const agentView = toAgentMessage(agentRow, "#files");
    expect(agentView.attachments[0]).not.toHaveProperty("imageWidth");
    expect(agentView.attachments[0]).not.toHaveProperty("imageHeight");
    const thread = await history.loadThread(
      f.workspace.id,
      f.owner.id,
      f.conversation.id,
      f.message.id,
    );
    expect(thread.replies[0]!.attachments[0]).toMatchObject({ imageWidth: 240, imageHeight: 320 });
    expect(thread.replies[0]!.attachments[0]).not.toHaveProperty("objectKey");
  } finally {
    await f.close();
  }
});

test("a direct message's immediate response and later history carry the same optional dimensions", async () => {
  const f = await attachmentCommentsFixture();
  try {
    const direct = new UserDirectConversations(f.db, { execute: (_scope, persist) => persist() });
    const { conversationId } = await direct.open(f.workspace.id, f.owner.id, f.member.id);
    const attachment = await f.db.attachment.create({
      data: {
        workspaceId: f.workspace.id,
        conversationId,
        uploaderId: f.owner.id,
        objectKey: `${f.attachment.objectKey}-dm`,
        fileName: "direct.png",
        contentType: "image/png",
        sizeBytes: 1,
        imageWidth: 300,
        imageHeight: 200,
      },
    });
    const sent = await direct.send({
      workspaceId: f.workspace.id,
      conversationId,
      senderUserId: f.owner.id,
      body: "image",
      attachmentIds: [attachment.id],
      idempotencyKey: crypto.randomUUID(),
    });
    const metadata = {
      id: attachment.id,
      fileName: attachment.fileName,
      contentType: attachment.contentType,
      sizeBytes: attachment.sizeBytes,
      imageWidth: 300,
      imageHeight: 200,
    };
    expect(sent.attachments[0]).toMatchObject(metadata);
    expect(sent.attachments[0]).not.toHaveProperty("objectKey");
    const page = await new ConversationHistory(f.db).loadAround(
      f.workspace.id,
      f.owner.id,
      conversationId,
      sent.id,
    );
    // Signed preview URLs are fresh per read; the persisted image metadata stays the same.
    expect(page.messages[0]!.attachments).toHaveLength(1);
    expect(page.messages[0]!.attachments[0]).toMatchObject(metadata);
    expect(page.messages[0]!.attachments[0]).not.toHaveProperty("objectKey");
  } finally {
    await f.close();
  }
});
