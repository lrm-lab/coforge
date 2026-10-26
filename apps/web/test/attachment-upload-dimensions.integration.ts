import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachmentCommentsFixture } from "./helpers/attachment-comments-fixture";
import { storeAttachment, storeAgentAttachment } from "#src/server/attachments/attachment.server";
import {
  createAttachmentUploadSession,
  completeAttachmentUploadSession,
  cancelAttachmentUploadSession,
} from "#src/server/attachments/attachment-upload-session.server";
import { LocalFileStorage, type FileStorage } from "#src/server/files/file-storage.server";
import { UserDirectConversations } from "#src/server/conversations/user-direct-conversations.server";
import { ConversationHistory } from "#src/server/conversations/conversation-history.server";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==",
  "base64",
);

test("browser upload dimensions survive real persistence, sending a DM and reading it later", async () => {
  const root = await mkdtemp(join(tmpdir(), "coforge-upload-size-"));
  const f = await attachmentCommentsFixture().catch(async (error: unknown) => {
    await rm(root, { recursive: true, force: true });
    throw error;
  });
  try {
    const direct = new UserDirectConversations(f.db, { execute: (_scope, persist) => persist() });
    const { conversationId } = await direct.open(f.workspace.id, f.owner.id, f.member.id);
    const uploaded = await storeAttachment(
      f.db,
      {
        userId: f.owner.id,
        conversationId,
        file: new File([png], "pixel.png", { type: "image/png" }),
      },
      async () => new LocalFileStorage(root),
    );
    const sent = await direct.send({
      workspaceId: f.workspace.id,
      conversationId,
      senderUserId: f.owner.id,
      body: "pixel",
      attachmentIds: [uploaded.id],
      idempotencyKey: crypto.randomUUID(),
    });
    const page = await new ConversationHistory(f.db).loadAround(
      f.workspace.id,
      f.owner.id,
      conversationId,
      sent.id,
    );
    for (const view of [sent.attachments[0], page.messages[0]!.attachments[0]]) {
      expect(view).toMatchObject({ id: uploaded.id, imageWidth: 1, imageHeight: 1 });
      expect(view).not.toHaveProperty("objectKey");
    }
  } finally {
    await Promise.all([f.close(), rm(root, { recursive: true, force: true })]);
  }
});

test("Agent multipart and direct uploads persist dimensions while the Agent upload response stays unchanged", async () => {
  const f = await attachmentCommentsFixture();
  try {
    const agent = await f.db.agent.create({
      data: {
        workspaceId: f.workspace.id,
        ownerId: f.owner.id,
        name: "image-uploader",
        displayName: "Uploader",
        runtimeConfig: {},
      },
    });
    let prefixes = 0;
    const storage: FileStorage = {
      put: async () => {},
      remove: async () => {},
      open: async () => {
        throw new Error("full download forbidden");
      },
      head: async () => ({ sizeBytes: png.length, contentType: "image/png" }),
      presignPut: async () => ({ url: "https://storage.example.test/upload", headers: {} }),
      readPrefix: async (_key, options) => {
        prefixes++;
        expect(options.maxBytes).toBe(png.length);
        return png;
      },
    };
    const multipart = await storeAgentAttachment(
      f.db,
      {
        agentId: agent.id,
        workspaceId: f.workspace.id,
        conversationId: f.conversation.id,
        file: new File([png], "pixel.png"),
        contentType: "image/png",
      },
      async () => storage,
    );
    expect(prefixes).toBe(0);
    const session = await createAttachmentUploadSession(f.db, storage, {
      agentId: agent.id,
      workspaceId: f.workspace.id,
      conversationId: f.conversation.id,
      fileName: "pixel.png",
      contentType: "image/png",
      sizeBytes: png.length,
      idempotencyKey: crypto.randomUUID(),
    });
    const scope = { agentId: agent.id, workspaceId: f.workspace.id, uploadId: session.uploadId };
    const complete = await completeAttachmentUploadSession(f.db, storage, scope);
    expect(await completeAttachmentUploadSession(f.db, storage, scope)).toEqual(complete);
    expect(prefixes).toBe(1);
    for (const uploaded of [multipart, complete.attachment]) {
      const row = await f.db.attachment.findUniqueOrThrow({ where: { id: uploaded.id } });
      expect(row).toMatchObject({ imageWidth: 1, imageHeight: 1, uploaderAgentId: agent.id });
      expect(uploaded).not.toHaveProperty("imageWidth");
      expect(uploaded).not.toHaveProperty("imageHeight");
    }
  } finally {
    await f.close();
  }
});

test("direct-upload metadata errors, corrupt data and unavailable prefix support never fail completion", async () => {
  const f = await attachmentCommentsFixture();
  try {
    const agent = await f.db.agent.create({
      data: {
        workspaceId: f.workspace.id,
        ownerId: f.owner.id,
        name: "unknown-uploader",
        displayName: "Uploader",
        runtimeConfig: {},
      },
    });
    for (const readPrefix of [
      undefined,
      async () => {
        throw new Error("storage failed");
      },
      async () => new Uint8Array([1, 2, 3]),
    ]) {
      const storage: FileStorage = {
        put: async () => {},
        remove: async () => {},
        open: async () => {
          throw new Error("full download forbidden");
        },
        head: async () => ({ sizeBytes: 3, contentType: "image/png" }),
        presignPut: async () => ({ url: "https://storage.example.test/upload", headers: {} }),
        ...(readPrefix ? { readPrefix } : {}),
      };
      const session = await createAttachmentUploadSession(f.db, storage, {
        agentId: agent.id,
        workspaceId: f.workspace.id,
        conversationId: f.conversation.id,
        fileName: "unknown.png",
        contentType: "image/png",
        sizeBytes: 3,
        idempotencyKey: crypto.randomUUID(),
      });
      const completed = await completeAttachmentUploadSession(f.db, storage, {
        agentId: agent.id,
        workspaceId: f.workspace.id,
        uploadId: session.uploadId,
      });
      expect(completed.state).toBe("completed");
      expect(
        await f.db.attachment.findUniqueOrThrow({
          where: { id: completed.attachment.id },
          select: { imageWidth: true, imageHeight: true },
        }),
      ).toEqual({ imageWidth: null, imageHeight: null });
    }
  } finally {
    await f.close();
  }
});

test("canceling a direct upload while its header is being read cannot resurrect a completed attachment", async () => {
  const f = await attachmentCommentsFixture();
  const entered = Promise.withResolvers<void>();
  const prefix = Promise.withResolvers<Uint8Array>();
  let completion: Promise<unknown> | undefined;
  try {
    const agent = await f.db.agent.create({
      data: {
        workspaceId: f.workspace.id,
        ownerId: f.owner.id,
        name: "canceled-uploader",
        displayName: "Uploader",
        runtimeConfig: {},
      },
    });
    const storage: FileStorage = {
      put: async () => {},
      remove: async () => {},
      open: async () => null,
      head: async () => ({ sizeBytes: png.length, contentType: "image/png" }),
      presignPut: async () => ({ url: "https://storage.example.test/upload", headers: {} }),
      readPrefix: async () => {
        entered.resolve();
        return prefix.promise;
      },
    };
    const session = await createAttachmentUploadSession(f.db, storage, {
      agentId: agent.id,
      workspaceId: f.workspace.id,
      conversationId: f.conversation.id,
      fileName: "canceled.png",
      contentType: "image/png",
      sizeBytes: png.length,
      idempotencyKey: crypto.randomUUID(),
    });
    const scope = { agentId: agent.id, workspaceId: f.workspace.id, uploadId: session.uploadId };
    completion = completeAttachmentUploadSession(f.db, storage, scope);
    await entered.promise;
    expect((await cancelAttachmentUploadSession(f.db, storage, scope)).state).toBe("canceled");
    prefix.resolve(png);
    await expect(completion).rejects.toMatchObject({ code: "UPLOAD_SESSION_NOT_FOUND" });
    expect(await f.db.attachment.findUnique({ where: { id: session.attachmentId } })).toBeNull();
    expect(
      (await f.db.attachmentUploadSession.findUniqueOrThrow({ where: { id: session.uploadId } }))
        .state,
    ).toBe("canceled");
  } finally {
    prefix.resolve(png);
    await completion?.catch(() => undefined);
    await f.close();
  }
});
