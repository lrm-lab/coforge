import { expect, test } from "bun:test";
import { AppError } from "#src/lib/app-error";
import { AttachmentComments } from "#src/server/attachments/attachment-comments.server";
import { PrismaAttachmentCommentStore } from "#src/server/db/repositories/attachment-comments.repositories.server";
import { DirectConversations } from "#src/server/conversations/direct-conversations.server";
import { PublicChannels } from "#src/server/conversations/public-channels.server";
import { TaskBoard } from "#src/server/tasks/task-board.server";
import { attachmentCommentsFixture } from "./helpers/attachment-comments-fixture";

for (const operation of ["send", "reaction", "task-create", "task-convert"] as const) {
  test(`ordinary ${operation} refuses a comment seat exactly like a nonexistent destination`, async () => {
    const f = await attachmentCommentsFixture();
    try {
      const sent = await new AttachmentComments(new PrismaAttachmentCommentStore(f.db)).post(
        f.actor,
        { attachmentId: f.attachment.id, body: "Only a comment" },
      );
      const stored = await f.db.message.findUniqueOrThrow({ where: { id: sent.id } });
      for (const conversationId of [crypto.randomUUID(), stored.conversationId]) {
        if (operation === "send") {
          const message = {
            idempotencyKey: crypto.randomUUID(),
            body: "Must not become a chat message",
          };
          await expect(
            new DirectConversations(f.db).send(
              f.workspace.id,
              f.owner.id,
              conversationId,
              message,
              {
                idempotency: {
                  execute: async () => {
                    throw new Error("Unauthorized send reached idempotency");
                  },
                },
                centrifugo: {
                  publish: async () => {
                    throw new Error("Unauthorized send reached transport");
                  },
                },
              },
            ),
          ).rejects.toEqual(new AppError("NOT_FOUND"));
          await expect(
            new PublicChannels(f.db).send({ ...f.actor, channelId: conversationId, ...message }),
          ).rejects.toEqual(new AppError("NOT_FOUND"));
        } else if (operation === "reaction") {
          const reaction = { messageId: sent.id, emoji: "✅", active: true };
          await expect(
            new DirectConversations(f.db).react(
              f.workspace.id,
              f.owner.id,
              conversationId,
              reaction,
            ),
          ).rejects.toEqual(new AppError("NOT_FOUND"));
          await expect(
            new PublicChannels(f.db).toggleUserReaction(
              f.workspace.id,
              f.owner.id,
              conversationId,
              sent.id,
              "✅",
              true,
            ),
          ).rejects.toEqual(new AppError("NOT_FOUND"));
        } else {
          await expect(
            new TaskBoard(f.db).execute(f.actor, {
              operation: operation === "task-create" ? "create" : "convert",
              conversationId,
              idempotencyKey: crypto.randomUUID(),
              ...(operation === "task-create"
                ? { title: "Not a task conversation" }
                : { messageId: sent.id }),
            }),
          ).rejects.toEqual(new AppError("NOT_FOUND"));
        }
      }
      expect(await f.db.task.count({ where: { workspaceId: f.workspace.id } })).toBe(0);
      expect(await f.db.message.count({ where: { conversationId: stored.conversationId } })).toBe(
        1,
      );
    } finally {
      await f.close();
    }
  });
}
