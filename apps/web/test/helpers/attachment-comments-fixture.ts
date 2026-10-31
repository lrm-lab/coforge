import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";

export async function attachmentCommentsFixture(existingDb?: PrismaClient) {
  const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
  if (!connectionString) throw new Error("CHANNEL_TEST_DATABASE_URL is required");
  const db = existingDb ?? new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const suffix = crypto.randomUUID();
  const people = await Promise.all(
    ["owner", "member", "viewer", "outsider"].map((name) =>
      db.user.create({ data: { username: `${name}-${suffix}`, displayName: name } }),
    ),
  );
  const [owner, member, viewer, outsider] = people;
  const workspace = await db.workspace.create({
    data: {
      slug: `comments-${suffix}`,
      name: "File review",
      members: {
        create: people
          .slice(0, 3)
          .map((user) => ({ userId: user.id, role: user.id === owner.id ? "owner" : "member" })),
      },
    },
  });
  const conversation = await db.conversation.create({
    data: {
      workspaceId: workspace.id,
      channelName: "files",
      members: { create: [owner, member].map((user) => ({ userId: user.id })) },
    },
    include: { members: true },
  });
  const message = await db.message.create({
    data: {
      workspaceId: workspace.id,
      conversationId: conversation.id,
      body: "Review this file",
      sequence: 1,
      senderMemberId: conversation.members.find((row) => row.userId === owner.id)!.id,
    },
  });
  const attachment = await db.attachment.create({
    data: {
      workspaceId: workspace.id,
      conversationId: conversation.id,
      messageId: message.id,
      uploaderId: owner.id,
      objectKey: `test/comments/${suffix}`,
      fileName: "review.txt",
      contentType: "text/plain",
      sizeBytes: 1,
    },
  });
  return {
    db,
    owner,
    member,
    viewer,
    outsider,
    workspace,
    conversation,
    attachment,
    message,
    actor: { workspaceId: workspace.id, userId: owner.id },
    async close() {
      await db.message.deleteMany({ where: { workspaceId: workspace.id } });
      await db.workspace.delete({ where: { id: workspace.id } });
      await db.user.deleteMany({ where: { id: { in: people.map((user) => user.id) } } });
      if (!existingDb) await db.$disconnect();
    },
  };
}

import { AttachmentComments } from "#src/server/attachments/attachment-comments.server";
import { attachmentCommentNotices } from "#src/server/attachments/attachment-comment-notices.server";
import { PrismaAttachmentCommentStore } from "#src/server/db/repositories/attachment-comments.repositories.server";
import { recordingDeliveries } from "./fake-centrifugo";

/** A comments store wired to a recording publisher, for notification assertions. */
export const commentNoticesFor = (f: Awaited<ReturnType<typeof attachmentCommentsFixture>>) => {
  const { publisher, delivered } = recordingDeliveries();
  const activityChanged: { workspaceId: string; userId: string }[] = [];
  const notices = attachmentCommentNotices(f.db, publisher, {
    activityChanged: async (event) => {
      activityChanged.push(event);
    },
  });
  const comments = new AttachmentComments(new PrismaAttachmentCommentStore(f.db));
  return { comments, notices, delivered, activityChanged };
};

/** The `pending_mention_actions` rows a comment message wrote. */
export const commentPmaOf = (
  f: Awaited<ReturnType<typeof attachmentCommentsFixture>>,
  messageId: string,
) => f.db.pendingMentionAction.findMany({ where: { messageId } });
