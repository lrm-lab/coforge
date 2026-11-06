import { afterAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { listConversationFiles } from "#src/server/conversations/conversation-files.server";

/**
 * The Files tab lists files a message carried, never an upload nobody sent (task #617): an
 * upload lands with `messageId` null and only the send claims it.
 *
 * Skipped unless `CHANNEL_TEST_DATABASE_URL` points at local PostgreSQL.
 */
const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
const db = connectionString
  ? new PrismaClient({ adapter: new PrismaPg({ connectionString }) })
  : (null as unknown as PrismaClient);

const handle = crypto.randomUUID().slice(0, 8);
let workspaceId: string;
let userId: string;
let conversationId: string;

test.skipIf(!connectionString)("the files list holds sent attachments only", async () => {
  userId = (await db.user.create({ data: { username: `files-${handle}`, displayName: "Files" } }))
    .id;
  workspaceId = (
    await db.workspace.create({
      data: {
        slug: `files-${handle}`,
        name: "Files",
        members: { create: [{ userId, role: "owner" }] },
      },
    })
  ).id;
  conversationId = (
    await db.conversation.create({
      data: {
        workspaceId,
        channelName: `files-${handle}`,
        visibility: "public",
        members: { create: [{ userId }] },
      },
    })
  ).id;
  const member = await db.conversationMember.findFirstOrThrow({
    where: { conversationId, userId },
  });
  const message = await db.message.create({
    data: { workspaceId, conversationId, senderMemberId: member.id, sequence: 1, body: "hi" },
  });
  const upload = (fileName: string, messageId: string | null) =>
    db.attachment.create({
      data: {
        workspaceId,
        conversationId,
        uploaderId: userId,
        messageId,
        objectKey: `workspaces/${workspaceId}/attachments/${crypto.randomUUID()}/original`,
        fileName,
        contentType: "text/plain",
        sizeBytes: 5,
      },
    });
  await upload("sent.txt", message.id);
  await upload("unsent.txt", null);

  const { files } = await listConversationFiles(db, {
    workspaceId,
    userId,
    conversationId,
  });
  expect(files.map((file) => file.fileName)).toEqual(["sent.txt"]);
});

afterAll(async () => {
  if (!connectionString) return;
  await db.workspace.delete({ where: { id: workspaceId } }).catch(() => undefined);
  await db.user.deleteMany({ where: { id: userId } });
  await db.$disconnect();
});
