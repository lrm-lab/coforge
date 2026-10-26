import type { PrismaClient } from "#src/generated/prisma/client";
import { AttachmentCommentMigration } from "#src/server/attachments/attachment-comment-migration.server";
import { PrismaAttachmentCommentMigrationStore } from "#src/server/db/repositories/attachment-comment-migration.repositories.server";
import { AttachmentComments } from "#src/server/attachments/attachment-comments.server";
import { PrismaAttachmentCommentStore } from "#src/server/db/repositories/attachment-comments.repositories.server";
import { attachmentCommentsFixture } from "./attachment-comments-fixture";

export async function legacyDiscussion(options?: {
  db?: PrismaClient;
  localCopy?: { database: string; schema: string };
}) {
  if (!Bun.env.MIGRATION_TEST_DATABASE_URL || !Bun.env.CHANNEL_TEST_DATABASE_URL)
    throw new Error("MIGRATION_TEST_DATABASE_URL and CHANNEL_TEST_DATABASE_URL are required");
  const f = await attachmentCommentsFixture(options?.db);
  try {
    const second = await f.db.attachment.create({
      data: {
        workspaceId: f.workspace.id,
        conversationId: f.conversation.id,
        messageId: f.message.id,
        position: 1,
        uploaderId: f.owner.id,
        objectKey: `${f.attachment.objectKey}/second`,
        fileName: "second.txt",
        contentType: "text/plain",
        sizeBytes: 1,
      },
    });
    const comments = new AttachmentComments(new PrismaAttachmentCommentStore(f.db));
    const first = await comments.post(f.actor, {
      attachmentId: f.attachment.id,
      body: "First file",
    });
    const other = await comments.post(f.actor, { attachmentId: second.id, body: "Second file" });
    const reply = await comments.post(
      { workspaceId: f.workspace.id, userId: f.member.id },
      { attachmentId: f.attachment.id, rootId: first.id, body: "An existing nested reply" },
    );
    await comments.react(f.actor, {
      attachmentId: f.attachment.id,
      messageId: reply.id,
      emoji: "✅",
      active: true,
    });
    for (const [id, minute] of [
      [first.id, 0],
      [other.id, 1],
      [reply.id, 2],
    ] as const) {
      await f.db.message.update({
        where: { id },
        data: { createdAt: new Date(`2026-10-25T10:0${minute}:00.000Z`) },
      });
    }
    const existingReply = await f.db.message.create({
      data: {
        workspaceId: f.workspace.id,
        conversationId: f.conversation.id,
        senderMemberId: f.conversation.members[0]!.id,
        threadRootId: f.message.id,
        body: "An ordinary reply already here",
        sequence: 2,
      },
    });
    const migration = new AttachmentCommentMigration(
      new PrismaAttachmentCommentMigrationStore(f.db, { localCopy: options?.localCopy }),
    );
    return { ...f, second, first, other, reply, existingReply, migration };
  } catch (error) {
    await f.close();
    throw error;
  }
}

export async function migrationAssistant(
  f: Pick<Awaited<ReturnType<typeof legacyDiscussion>>, "db" | "workspace" | "owner">,
) {
  await f.db.workspaceAssistant.create({ data: { workspaceId: f.workspace.id } });
  const assistant = await f.db.agent.create({
    data: {
      workspaceId: f.workspace.id,
      ownerId: f.owner.id,
      name: "migration-assistant",
      displayName: "Migration assistant",
      visibility: "private",
      systemKind: "workspace-assistant",
      runtimeConfig: { runtime: "pi", provider: { kind: "default" }, model: "", reasoning: "" },
    },
  });
  const session = await f.db.workspaceAssistantSession.create({
    data: {
      workspaceId: f.workspace.id,
      userId: f.owner.id,
      agentId: assistant.id,
    },
  });
  return { assistant, session };
}
