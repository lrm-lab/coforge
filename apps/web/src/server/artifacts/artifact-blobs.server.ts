import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import type {
  BulkFileRemoval,
  FileStorage,
  StoredFile,
} from "#src/server/files/file-storage.server";
import { errorType } from "#src/server/errors/error-type.server";
import {
  ARTIFACT_BINARY_LIMIT,
  ARTIFACT_TEXT_LIMIT,
  type ArtifactBlobInfo,
  type ArtifactBlobStore,
} from "./artifacts.server";

/** How long an uploaded blob waits for a version to name it before the sweep removes it. */
export const ARTIFACT_BLOB_GRACE_MS = 24 * 60 * 60 * 1000;
/** Blobs one sweep transaction removes; the rest wait for the next batch. */
const SWEEP_BATCH = 500;
const SHA256 = /^[0-9a-f]{64}$/;

/** Where one upload of a Workspace's blob is stored. Under `workspaces/<id>/`, so a Workspace
 * delete's prefix sweep (`WorkspaceFileCleanup`) removes it with everything else it stored; one
 * object per upload, so removing one never removes the bytes a later upload stored. */
export function artifactBlobKey(workspaceId: string, sha256: string, uploadId: string): string {
  return `workspaces/${workspaceId}/artifacts/blobs/${sha256}/${uploadId}`;
}

type Bucket = FileStorage & Pick<BulkFileRemoval, "removeMany">;

/**
 * Artifact bytes (task #385): an object in the private file bucket per Workspace and sha256, with
 * an `artifact_blobs` row saying its size, its kind and its object. The server hashes and
 * classifies the bytes itself, so a version's file sizes and kinds never come from the client.
 *
 * A blob no version names is removed a day after its last use (`removeUnreferenced`). The
 * objects go after the rows, so a row always names bytes that exist.
 */
export class StoredArtifactBlobs implements ArtifactBlobStore {
  constructor(
    private readonly db: PrismaClient,
    private readonly bucket: () => Promise<Bucket>,
  ) {}

  async inspectMany(workspaceId: string, sha256s: readonly string[]) {
    if (sha256s.length === 0) return new Map<string, ArtifactBlobInfo>();
    const rows = await this.db.artifactBlob.findMany({
      where: { workspaceId, sha256: { in: [...sha256s] } },
      select: { sha256: true, sizeBytes: true, kind: true },
    });
    return new Map(rows.map((row) => [row.sha256, { sizeBytes: row.sizeBytes, kind: row.kind }]));
  }

  async use(tx: Prisma.TransactionClient, workspaceId: string, sha256s: readonly string[]) {
    if (sha256s.length === 0) return [];
    const { count } = await tx.artifactBlob.updateMany({
      where: { workspaceId, sha256: { in: [...sha256s] } },
      data: { lastUsedAt: new Date(), referenced: true },
    });
    if (count === sha256s.length) return [];
    const left = await tx.artifactBlob.findMany({
      where: { workspaceId, sha256: { in: [...sha256s] } },
      select: { sha256: true },
    });
    const stored = new Set(left.map((row) => row.sha256));
    return sha256s.filter((sha256) => !stored.has(sha256));
  }

  /** Stores `bytes` under their sha256, once. `sha256`, when the client names one, must be theirs. */
  async upload(input: { workspaceId: string; bytes: Uint8Array<ArrayBuffer>; sha256?: string }) {
    const { workspaceId, bytes } = input;
    // Text has the larger limit, so nothing larger is read as either.
    if (bytes.length > ARTIFACT_TEXT_LIMIT) invalid("artifact-file-too-large");
    const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
    if (input.sha256 !== undefined && input.sha256 !== sha256) invalid("artifact-blob-sha256");
    const kind = isText(bytes) ? "text" : "binary";
    if (kind === "binary" && bytes.length > ARTIFACT_BINARY_LIMIT)
      invalid("artifact-file-too-large");
    const blob = { sha256, sizeBytes: bytes.length, kind };

    // Stored already: uploading again counts as a use, so the save that follows finds it.
    const { count: known } = await this.db.artifactBlob.updateMany({
      where: { workspaceId, sha256 },
      data: { lastUsedAt: new Date() },
    });
    if (known) return blob;
    // The object first, then the row that names it.
    const objectKey = artifactBlobKey(workspaceId, sha256, crypto.randomUUID());
    const bucket = await this.bucket();
    await bucket.put(
      objectKey,
      new Blob([bytes]),
      kind === "text" ? "text/plain; charset=utf-8" : "application/octet-stream",
    );
    const { count } = await this.db.artifactBlob.createMany({
      data: [{ workspaceId, ...blob, objectKey }],
      skipDuplicates: true,
    });
    // The same bytes were stored meanwhile by another upload, whose row names its own object.
    if (count === 0) await bucket.remove(objectKey).catch(() => undefined);
    return blob;
  }

  /** One blob's bytes, or null when the Workspace stores none under `sha256`. */
  async open(workspaceId: string, sha256: string): Promise<StoredFile | null> {
    if (!SHA256.test(sha256)) return null;
    const row = await this.db.artifactBlob.findUnique({
      where: { workspaceId_sha256: { workspaceId, sha256 } },
      select: { objectKey: true },
    });
    return row ? (await this.bucket()).open(row.objectKey) : null;
  }

  /**
   * Removes the blobs unused for a day that no version names, `SWEEP_BATCH` at a time until none
   * is left, and returns how many went; then their objects, best effort. An object left behind by
   * a failed removal is named by no row, so it is never served, and the Workspace's delete
   * removes it.
   *
   * It reads only blobs no save has marked `referenced`, by the partial index on `lastUsedAt`,
   * so its cost follows the blobs waiting to go; the `NOT EXISTS` is a second guard.
   *
   * A save sets `lastUsedAt` on every blob it names, in its own transaction. So the sweep skips a
   * blob a save is writing (`SKIP LOCKED`), and one a save committed since the sweep's statement
   * began is rechecked at its newest row, now recent, and left (READ COMMITTED's recheck of a
   * row updated meanwhile). A save that comes after finds the row gone and answers `missing`.
   */
  async removeUnreferenced(now: Date = new Date()): Promise<number> {
    const before = new Date(now.getTime() - ARTIFACT_BLOB_GRACE_MS);
    let removed = 0;
    for (;;) {
      const gone = await this.db.$queryRaw<{ objectKey: string }[]>`
        DELETE FROM "artifact_blobs"
        WHERE ("workspaceId", "sha256") IN (
          SELECT b."workspaceId", b."sha256"
          FROM "artifact_blobs" b
          WHERE b."referenced" = false AND b."lastUsedAt" < ${before}
            AND NOT EXISTS (
              SELECT 1 FROM "artifact_files" f
              JOIN "artifacts" a ON a."id" = f."artifactId"
              WHERE f."sha256" = b."sha256" AND a."workspaceId" = b."workspaceId")
          ORDER BY b."lastUsedAt"
          LIMIT ${SWEEP_BATCH}
          FOR UPDATE OF b SKIP LOCKED)
        RETURNING "objectKey"`;
      removed += gone.length;
      if (gone.length)
        await (
          await this.bucket()
        )
          .removeMany(gone.map((row) => row.objectKey))
          .catch((error: unknown) =>
            console.warn(
              JSON.stringify({
                event: "artifact_blobs:object_removal_failed",
                count: gone.length,
                error_type: errorType(error),
              }),
            ),
          );
      if (gone.length < SWEEP_BATCH) return removed;
    }
  }
}

/** UTF-8 that decodes without a NUL: what a text editor would open. */
function isText(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

function invalid(errorId: string): never {
  throw new AppError("INVALID_INPUT", { errorId });
}
