import { ARTIFACT_SHA256_PATTERN } from "@lrm/coforge-sdk/agent";
import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import type {
  BulkFileRemoval,
  FileStorage,
  StoredFile,
} from "#src/server/files/file-storage.server";
import { errorType } from "#src/server/errors/error-type.server";
import type { ArtifactPublisher } from "./artifact-access.server";
import {
  ARTIFACT_BINARY_LIMIT,
  ARTIFACT_TEXT_LIMIT,
  type ArtifactBlobInfo,
  type ArtifactBlobStore,
} from "./artifact-files.server";

/** How long an uploaded blob waits for a version to name it before the sweep removes it. */
export const ARTIFACT_BLOB_GRACE_MS = 24 * 60 * 60 * 1000;
/** Blobs one sweep transaction removes; the rest wait for the next batch. */
const SWEEP_BATCH = 500;

/** Where one upload of a Workspace's blob is stored. Under `workspaces/<id>/`, so a Workspace
 * delete's prefix sweep (`WorkspaceFileCleanup`) removes it with everything else it stored; one
 * object per upload, so removing one never removes the bytes a later upload stored. */
export function artifactBlobKey(workspaceId: string, sha256: string, uploadId: string): string {
  return `workspaces/${workspaceId}/artifacts/blobs/${sha256}/${uploadId}`;
}

/** An upload of bytes new to the Workspace that would take its unused bytes past the quota. */
export class ArtifactStorageFull extends Error {}

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

  /** Stores `bytes` under their sha256, once, and grants them to `actor`, who has shown it holds
   * them, for its saves. `sha256`, when the client names one, must be theirs. Bytes the Workspace
   * does not hold yet are refused (`ArtifactStorageFull`) when they would take its unreferenced
   * bytes past `unreferencedQuotaBytes`; bytes it holds add nothing. */
  async upload(input: {
    workspaceId: string;
    bytes: Uint8Array<ArrayBuffer>;
    sha256?: string;
    actor?: ArtifactPublisher;
    unreferencedQuotaBytes?: number;
  }) {
    const blob = await this.#store(input);
    if (!input.actor) return blob;
    const grant = () =>
      this.db.artifactBlobGrant.createMany({
        data: [
          { workspaceId: input.workspaceId, sha256: blob.sha256, actorKey: actorKey(input.actor!) },
        ],
        skipDuplicates: true,
      });
    // The sweep may take a blob unused for a day between the store and the grant: store again.
    await grant().catch(async () => {
      await this.#store(input);
      await grant();
    });
    return blob;
  }

  /** Of `sha256s`, the ones `actor` may name in a save of `artifactId`: granted to it, or used by
   * one of that artifact's versions already; without an artifact, only the grants count. */
  async allowed(
    workspaceId: string,
    artifactId: string | undefined,
    actor: ArtifactPublisher,
    sha256s: readonly string[],
  ): Promise<Set<string>> {
    if (sha256s.length === 0) return new Set();
    const [granted, used] = await Promise.all([
      this.db.artifactBlobGrant.findMany({
        where: { workspaceId, actorKey: actorKey(actor), sha256: { in: [...sha256s] } },
        select: { sha256: true },
      }),
      artifactId === undefined
        ? []
        : this.db.artifactFile.findMany({
            where: { artifactId, sha256: { in: [...sha256s] } },
            select: { sha256: true },
            distinct: ["sha256"],
          }),
    ]);
    return new Set([...granted, ...used].map((row) => row.sha256));
  }

  /** The bytes the Workspace stores that no saved version names yet: what the upload quota
   * counts, since a version's own bytes belong to its artifact. */
  async unreferencedBytes(workspaceId: string): Promise<number> {
    const total = await this.db.artifactBlob.aggregate({
      where: { workspaceId, referenced: false },
      _sum: { sizeBytes: true },
    });
    return total._sum.sizeBytes ?? 0;
  }

  async #store(input: {
    workspaceId: string;
    bytes: Uint8Array<ArrayBuffer>;
    sha256?: string;
    unreferencedQuotaBytes?: number;
  }) {
    const { workspaceId, bytes } = input;
    // Text has the larger limit, so nothing larger is read as either.
    if (bytes.length > ARTIFACT_TEXT_LIMIT) invalid("artifact-file-too-large");
    const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
    if (input.sha256 !== undefined && input.sha256 !== sha256)
      invalid("artifact-blob-sha256", "the bytes sent are not the file the path names");
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
    if (
      input.unreferencedQuotaBytes !== undefined &&
      (await this.unreferencedBytes(workspaceId)) + bytes.length > input.unreferencedQuotaBytes
    )
      throw new ArtifactStorageFull();
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
    if (!ARTIFACT_SHA256_PATTERN.test(sha256)) return null;
    const row = await this.db.artifactBlob.findUnique({
      where: { workspaceId_sha256: { workspaceId, sha256 } },
      select: { objectKey: true },
    });
    return row ? (await this.bucket()).open(row.objectKey) : null;
  }

  async read(workspaceId: string, sha256: string): Promise<Uint8Array | null> {
    const opened = await this.open(workspaceId, sha256);
    return opened ? new Uint8Array(await new Response(opened.body).arrayBuffer()) : null;
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

function invalid(errorId: string, hint?: string): never {
  throw new AppError("INVALID_INPUT", { errorId, ...(hint ? { hint } : {}) });
}

/** How a grant names its Agent. */
const actorKey = (actor: ArtifactPublisher) => `agent:${actor.agentId}`;
