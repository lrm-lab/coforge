import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { AttachmentComments } from "#src/server/attachments/attachment-comments.server";
import { PrismaAttachmentCommentStore } from "#src/server/db/repositories/attachment-comments.repositories.server";
import { PrismaAgentDeletionStore } from "#src/server/db/repositories/agent-deletion.repositories.server";
import { attachmentCommentsFixture } from "./helpers/attachment-comments-fixture";

test("production has no raw User or Agent hard-delete operation that could bypass discussion cleanup", async () => {
  const root = join(import.meta.dir, "../src");
  const violations: string[] = [];
  for await (const name of new Bun.Glob("**/*.ts").scan(root)) {
    if (name.startsWith("generated/") || name.endsWith(".test.ts")) continue;
    if (/\.(user|agent)\.(delete|deleteMany)\s*\(/.test(await readFile(join(root, name), "utf8")))
      violations.push(name);
  }
  expect(violations).toEqual([]);
});

test("uploader Agent soft deletion preserves the file and its discussion; raw author deletion is restricted", async () => {
  const f = await attachmentCommentsFixture();
  try {
    const agent = await f.db.agent.create({
      data: {
        workspaceId: f.workspace.id,
        ownerId: f.owner.id,
        name: "uploader",
        displayName: "Uploader",
        runtimeConfig: {},
      },
    });
    await f.db.conversationMember.create({
      data: { workspaceId: f.workspace.id, conversationId: f.conversation.id, agentId: agent.id },
    });
    await f.db.attachment.update({
      where: { id: f.attachment.id },
      data: { uploaderId: null, uploaderAgentId: agent.id },
    });
    const comments = new AttachmentComments(new PrismaAttachmentCommentStore(f.db));
    const sent = await comments.post(
      { workspaceId: f.workspace.id, agentId: agent.id },
      { attachmentId: f.attachment.id, body: "Keep uploaded file review" },
    );
    expect(
      (
        await new PrismaAgentDeletionStore(f.db).delete({
          workspaceId: f.workspace.id,
          agentId: agent.id,
          deletedAt: new Date(),
        })
      ).outcome,
    ).toBe("deleted");
    expect(await f.db.attachment.count({ where: { id: f.attachment.id } })).toBe(1);
    expect((await comments.list(f.actor, { attachmentId: f.attachment.id })).comments[0]?.id).toBe(
      sent.id,
    );
    await expect(
      Promise.resolve(f.db.agent.delete({ where: { id: agent.id } })),
    ).rejects.toMatchObject({
      code: "P2003",
    });
    await expect(
      Promise.resolve(f.db.user.delete({ where: { id: f.owner.id } })),
    ).rejects.toMatchObject({
      code: "P2003",
    });
    expect(
      await f.db.attachmentCommentThread.count({ where: { attachmentId: f.attachment.id } }),
    ).toBe(1);
  } finally {
    await f.close();
  }
});
