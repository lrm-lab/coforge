import type { PrismaClient } from "#src/generated/prisma/client";
import type { StoredArtifactBlobs } from "./artifact-blobs.server";
import { imagesOf, type DraftRow } from "./artifact-comment-draft-rows.server";
import { WRITE_TIMEOUT_MS } from "./artifact-comment-write.server";

const SWEEP_BATCH = 500;

export async function sweepExpiredDrafts(
  db: PrismaClient,
  blobs: Pick<StoredArtifactBlobs, "release"> & Partial<Pick<StoredArtifactBlobs, "releaseMany">>,
  now: Date = new Date(),
): Promise<number> {
  let removed = 0;
  for (;;) {
    const batch = await db.$transaction(
      async (tx) => {
        const gone = await tx.$queryRaw<{ workspaceId: string; images: DraftRow["images"] }[]>`
          DELETE FROM "artifact_comment_drafts" d
          USING "artifacts" a
          WHERE a."id" = d."artifactId" AND d."id" IN (
            SELECT "id" FROM "artifact_comment_drafts"
            WHERE "expiresAt" <= ${now}
            ORDER BY "expiresAt"
            LIMIT ${SWEEP_BATCH}
            FOR UPDATE SKIP LOCKED)
          RETURNING a."workspaceId", d."images"`;
        const pairs: { workspaceId: string; sha256: string }[] = [];
        for (const row of gone) {
          for (const { sha256 } of imagesOf(row)) {
            pairs.push({ workspaceId: row.workspaceId, sha256 });
          }
        }
        if (pairs.length > 0) {
          if (blobs.releaseMany) {
            await blobs.releaseMany(tx, pairs);
          } else {
            const byWorkspace = new Map<string, Set<string>>();
            for (const pair of pairs) {
              byWorkspace.set(
                pair.workspaceId,
                (byWorkspace.get(pair.workspaceId) ?? new Set()).add(pair.sha256),
              );
            }
            for (const [workspaceId, shas] of [...byWorkspace.entries()].sort(([a], [b]) =>
              a.localeCompare(b),
            ))
              await blobs.release(tx, workspaceId, [...shas].sort());
          }
        }
        return gone.length;
      },
      { timeout: WRITE_TIMEOUT_MS },
    );
    removed += batch;
    if (batch < SWEEP_BATCH) return removed;
  }
}
