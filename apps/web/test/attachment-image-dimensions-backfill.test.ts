import { expect, test } from "bun:test";
import { backfillAttachmentImageDimensions } from "#src/server/attachments/attachment-image-dimensions-backfill.server";

const png = Buffer.from("89504e470d0a1a0a0000000d494844520000000c00000006", "hex");
function fakeDb(
  rows: Array<{
    id: string;
    createdAt: Date;
    imageWidth: number | null;
    imageHeight: number | null;
  }>,
) {
  const updates: unknown[] = [];
  const db = {
    $queryRaw: async () => [
      {
        images: rows.length,
        totalBytes: rows.length * png.length,
        readBytesUpperBound: rows.length * png.length,
      },
    ],
    attachment: {
      findMany: async ({ where, take }: { where: { OR?: unknown[] }; take: number }) =>
        rows
          .filter((r) => !where.OR || r.id !== "done")
          .slice(0, take)
          .map((r) => ({ ...r, objectKey: r.id, contentType: "image/png", sizeBytes: png.length })),
      updateMany: async (query: unknown) => {
        updates.push(query);
        return { count: 1 };
      },
    },
  };
  return { updates, db: db as never };
}

test("dry-run reads a fixed candidate range without writing and reports unknowns", async () => {
  const { db, updates } = fakeDb([
    { id: "one", createdAt: new Date("2026-01-01"), imageWidth: null, imageHeight: null },
  ]);
  let batches = 0;
  const summary = await backfillAttachmentImageDimensions({
    db,
    cutoff: new Date("2026-01-02"),
    maxItems: 1,
    batchSize: 1,
    batchDelayMs: 0,
    dryRun: true,
    storage: { readPrefix: async () => png },
    onBatch: () => {
      batches++;
    },
  });
  expect(summary).toMatchObject({
    mode: "dry-run",
    candidates: 1,
    successes: 1,
    unknown: 0,
    failed: 0,
  });
  expect(updates).toHaveLength(0);
  expect(batches).toBe(1);
});

test("apply uses compare-and-set, classifies failures and emits a resumable cursor", async () => {
  const { db, updates } = fakeDb([
    { id: "one", createdAt: new Date("2026-01-01"), imageWidth: null, imageHeight: null },
  ]);
  const summary = await backfillAttachmentImageDimensions({
    db,
    cutoff: new Date("2026-01-02"),
    maxItems: 1,
    batchSize: 1,
    batchDelayMs: 0,
    dryRun: false,
    storage: { readPrefix: async () => new Uint8Array([1]) },
  });
  expect(summary).toMatchObject({
    mode: "apply",
    candidates: 1,
    successes: 0,
    unknown: 1,
    failed: 0,
    lastCursor: { id: "one" },
  });
  expect(updates).toHaveLength(0);
});

test("the approved max-items guard stops an accidental wider range", async () => {
  const { db } = fakeDb([
    { id: "one", createdAt: new Date(), imageWidth: null, imageHeight: null },
    { id: "two", createdAt: new Date(), imageWidth: null, imageHeight: null },
  ]);
  await expect(
    backfillAttachmentImageDimensions({
      db,
      cutoff: new Date(),
      maxItems: 1,
      batchSize: 1,
      batchDelayMs: 0,
      dryRun: true,
      storage: { readPrefix: async () => png },
    }),
  ).rejects.toThrow("max-items");
});
