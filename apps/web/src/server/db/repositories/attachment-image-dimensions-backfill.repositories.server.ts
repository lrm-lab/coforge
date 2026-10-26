import type { PrismaClient } from "#src/generated/prisma/client";

export const BACKFILL_IMAGE_TYPES = ["image/gif", "image/jpeg", "image/png", "image/webp"] as const;
export type BackfillCursor = { createdAt: Date; id: string } | null;
export type BackfillCandidate = {
  id: string;
  objectKey: string;
  contentType: string;
  sizeBytes: number;
  createdAt: Date;
};

export async function countAttachmentDimensionBackfillCandidates(db: PrismaClient, cutoff: Date) {
  const rows = await db.$queryRaw<
    { images: bigint; totalBytes: bigint; readBytesUpperBound: bigint }[]
  >`
    SELECT count(*)::bigint AS images,
           coalesce(sum("sizeBytes"::bigint), 0)::bigint AS "totalBytes",
           coalesce(sum(least("sizeBytes", 262144)::bigint), 0)::bigint AS "readBytesUpperBound"
    FROM "attachments"
    WHERE "createdAt" <= ${cutoff}
      AND "imageWidth" IS NULL AND "imageHeight" IS NULL
      AND "contentType" IN ('image/gif', 'image/jpeg', 'image/png', 'image/webp')
      AND "sizeBytes" > 0`;
  const row = rows[0] ?? { images: 0n, totalBytes: 0n, readBytesUpperBound: 0n };
  return {
    images: Number(row.images),
    totalBytes: Number(row.totalBytes),
    readBytesUpperBound: Number(row.readBytesUpperBound),
  };
}

export async function listAttachmentDimensionBackfillCandidates(
  db: PrismaClient,
  input: { cutoff: Date; after: BackfillCursor; limit: number },
): Promise<BackfillCandidate[]> {
  const cursor = input.after
    ? {
        OR: [
          { createdAt: { gt: input.after.createdAt } },
          { createdAt: input.after.createdAt, id: { gt: input.after.id } },
        ],
      }
    : {};
  return db.attachment.findMany({
    where: {
      createdAt: { lte: input.cutoff },
      imageWidth: null,
      imageHeight: null,
      contentType: { in: [...BACKFILL_IMAGE_TYPES] },
      sizeBytes: { gt: 0 },
      ...cursor,
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: input.limit,
    select: { id: true, objectKey: true, contentType: true, sizeBytes: true, createdAt: true },
  });
}

export async function setAttachmentDimensionsIfUnknown(
  db: PrismaClient,
  input: { id: string; imageWidth: number; imageHeight: number },
) {
  return (
    (
      await db.attachment.updateMany({
        where: { id: input.id, imageWidth: null, imageHeight: null },
        data: { imageWidth: input.imageWidth, imageHeight: input.imageHeight },
      })
    ).count === 1
  );
}
