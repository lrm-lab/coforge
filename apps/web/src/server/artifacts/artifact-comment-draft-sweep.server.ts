import type { PrismaClient } from "#src/generated/prisma/client";
import type { StoredArtifactBlobs } from "./artifact-blobs.server";
import { imagesOf, type DraftRow } from "./artifact-comment-draft-rows.server";
import { WRITE_TIMEOUT_MS } from "./artifact-comment-write.server";

const SWEEP_BATCH = 500;

export async function sweepExpiredDrafts(
  db: PrismaClient,
  blobs: Pick<StoredArtifactBlobs, "release">,
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
        const byWorkspace = new Map<string, Set<string>>();
        for (const row of gone)
          for (const { sha256 } of imagesOf(row))
            byWorkspace.set(
              row.workspaceId,
              (byWorkspace.get(row.workspaceId) ?? new Set()).add(sha256),
            );
        for (const [workspaceId, shas] of byWorkspace)
          await blobs.release(tx, workspaceId, [...shas].sort());
        return gone.length;
      },
      { timeout: WRITE_TIMEOUT_MS },
    );
    removed += batch;
    if (batch < SWEEP_BATCH) return removed;
  }
}
