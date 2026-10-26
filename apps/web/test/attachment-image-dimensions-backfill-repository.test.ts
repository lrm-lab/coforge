import { expect, test } from "bun:test";
import {
  countAttachmentDimensionBackfillCandidates,
  listAttachmentDimensionBackfillCandidates,
  setAttachmentDimensionsIfUnknown,
} from "#src/server/db/repositories/attachment-image-dimensions-backfill.repositories.server";

test("backfill candidate reads are bounded, ordered by a stable timestamp/id cursor and count capped reads", async () => {
  const calls: unknown[] = [];
  const db = {
    $queryRaw: async (query: unknown) => {
      calls.push(query);
      return [{ images: 2n, totalBytes: 300000n, readBytesUpperBound: 262144n }];
    },
    attachment: {
      findMany: async (query: unknown) => {
        calls.push(query);
        return [];
      },
      updateMany: async (query: unknown) => {
        calls.push(query);
        return { count: 1 };
      },
    },
  };
  expect(
    await countAttachmentDimensionBackfillCandidates(db as never, new Date("2026-01-01")),
  ).toEqual({ images: 2, totalBytes: 300000, readBytesUpperBound: 262144 });
  expect(
    await listAttachmentDimensionBackfillCandidates(db as never, {
      cutoff: new Date("2026-01-01"),
      after: { createdAt: new Date("2025-01-01"), id: "a" },
      limit: 25,
    }),
  ).toEqual([]);
  expect(
    await setAttachmentDimensionsIfUnknown(db as never, {
      id: "a",
      imageWidth: 10,
      imageHeight: 20,
    }),
  ).toBe(true);
  expect(calls).toHaveLength(3);
  expect((calls[1] as { orderBy: unknown }).orderBy).toEqual([{ createdAt: "asc" }, { id: "asc" }]);
  expect((calls[2] as { where: unknown }).where).toMatchObject({
    id: "a",
    imageWidth: null,
    imageHeight: null,
  });
});
