import { expect, test } from "bun:test";
import { attachmentCommentsFixture } from "./helpers/attachment-comments-fixture";
import { backfillAttachmentImageDimensions } from "#src/server/attachments/attachment-image-dimensions-backfill.server";
import type { FileStorage } from "#src/server/files/file-storage.server";

const url = Bun.env.ATTACHMENT_DIMENSIONS_BACKFILL_TEST_DATABASE_URL;
if (!url)
  throw new Error(
    "ATTACHMENT_DIMENSIONS_BACKFILL_TEST_DATABASE_URL must point to local PostgreSQL",
  );

test("the real repository backfill is bounded, idempotent and dry-run never writes", async () => {
  const f = await attachmentCommentsFixture();
  try {
    const cutoff = new Date("2026-01-02T00:00:00Z");
    const first = await f.db.attachment.create({
      data: {
        workspaceId: f.workspace.id,
        conversationId: f.conversation.id,
        messageId: f.message.id,
        uploaderId: f.owner.id,
        objectKey: "test/backfill/one",
        fileName: "one.png",
        contentType: "image/png",
        sizeBytes: 24,
        createdAt: new Date("2026-01-01T00:00:00Z"),
      },
    });
    const second = await f.db.attachment.create({
      data: {
        workspaceId: f.workspace.id,
        conversationId: f.conversation.id,
        messageId: f.message.id,
        uploaderId: f.owner.id,
        objectKey: "test/backfill/two",
        fileName: "two.png",
        contentType: "image/png",
        sizeBytes: 24,
        createdAt: new Date("2026-01-01T00:00:01Z"),
      },
    });
    const storage: FileStorage = {
      put: async () => {},
      open: async () => null,
      remove: async () => {},
      head: async () => null,
      readPrefix: async (key) => (key.endsWith("one") ? new Uint8Array([1]) : new Uint8Array([1])),
    };
    const dry = await backfillAttachmentImageDimensions({
      db: f.db,
      cutoff,
      maxItems: 2,
      batchSize: 1,
      batchDelayMs: 0,
      dryRun: true,
      storage,
    });
    expect(dry).toMatchObject({ candidates: 2, successes: 0, unknown: 2 });
    expect(
      await f.db.attachment.findUniqueOrThrow({
        where: { id: first.id },
        select: { imageWidth: true, imageHeight: true },
      }),
    ).toEqual({ imageWidth: null, imageHeight: null });
    const applied = await backfillAttachmentImageDimensions({
      db: f.db,
      cutoff,
      maxItems: 2,
      batchSize: 1,
      batchDelayMs: 0,
      dryRun: false,
      storage: {
        ...storage,
        readPrefix: async () =>
          new Uint8Array([
            0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0,
            12, 0, 0, 0, 6,
          ]),
      },
    });
    expect(applied.successes).toBe(2);
    expect(
      (
        await f.db.attachment.findUniqueOrThrow({
          where: { id: second.id },
          select: { imageWidth: true, imageHeight: true },
        })
      ).imageWidth,
    ).toBe(12);
    const replay = await backfillAttachmentImageDimensions({
      db: f.db,
      cutoff,
      maxItems: 0,
      batchSize: 1,
      batchDelayMs: 0,
      dryRun: true,
      storage,
    });
    expect(replay.candidates).toBe(0);
  } finally {
    await f.close();
  }
});
