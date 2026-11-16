import { ARTIFACT_SHA256_PATTERN } from "@lrm/coforge-sdk/agent";
import { Prisma, type PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import type {
  BulkFileRemoval,
  FileStorage,
  StoredFile,
} from "#src/server/files/file-storage.server";
import { errorType } from "#src/server/errors/error-type.server";
import type { ArtifactActor } from "./artifact-access.server";
import { commentColumns } from "./artifact-actor-columns.server";
import {
  ARTIFACT_BINARY_LIMIT,
  ARTIFACT_TEXT_LIMIT,
  type ArtifactBlobInfo,
  type ArtifactBlobStore,
} from "./artifact-files.server";

export const ARTIFACT_BLOB_GRACE_MS = 24 * 60 * 60 * 1000;
const SWEEP_BATCH = 500;

export function artifactBlobKey(workspaceId: string, sha256: string, uploadId: string): string {
  return `workspaces/${workspaceId}/artifacts/blobs/${sha256}/${uploadId}`;
}

export class ArtifactStorageFull extends Error {}

type Bucket = FileStorage & Pick<BulkFileRemoval, "removeMany">;

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

  async release(tx: Prisma.TransactionClient, workspaceId: string, sha256s: readonly string[]) {
    if (sha256s.length === 0) return;
    await tx.$queryRaw`
      SELECT 1 FROM "artifact_blobs"
      WHERE "workspaceId" = ${workspaceId}::uuid AND "sha256" = ANY(${[...sha256s]}::text[])
      ORDER BY "sha256"
      FOR UPDATE`;
    await tx.$executeRaw`
      UPDATE "artifact_blobs" b
      SET "referenced" = false, "lastUsedAt" = now()
      WHERE b."workspaceId" = ${workspaceId}::uuid AND b."sha256" = ANY(${[...sha256s]}::text[])
        AND ${NO_OTHER_REFERENCE}`;
  }

  async upload(input: {
    workspaceId: string;
    bytes: Uint8Array<ArrayBuffer>;
    sha256?: string;
    actor: ArtifactActor;
    unreferencedQuotaBytes?: number;
  }) {
    const blob = await this.#store(input);
    const grant = () =>
      this.db.artifactBlobGrant.createMany({
        data: [
          { workspaceId: input.workspaceId, sha256: blob.sha256, actorKey: actorKey(input.actor) },
        ],
        skipDuplicates: true,
      });
    await grant().catch(async () => {
      await this.#store(input);
      await grant();
    });
    return blob;
  }

  put(workspaceId: string, bytes: Uint8Array<ArrayBuffer>) {
    return this.#store({ workspaceId, bytes });
  }

  async allowed(
    workspaceId: string,
    artifactId: string | undefined,
    actor: ArtifactActor,
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
    if (bytes.length > ARTIFACT_TEXT_LIMIT) invalid("artifact-file-too-large");
    const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
    if (input.sha256 !== undefined && input.sha256 !== sha256)
      invalid("artifact-blob-sha256", "the bytes sent are not the file the path names");
    const kind = isText(bytes) ? "text" : "binary";
    if (kind === "binary" && bytes.length > ARTIFACT_BINARY_LIMIT)
      invalid("artifact-file-too-large");
    const blob = { sha256, sizeBytes: bytes.length, kind };

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
    if (count === 0) await bucket.remove(objectKey).catch(() => undefined);
    return blob;
  }

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
            AND ${NO_OTHER_REFERENCE}
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

const NO_OTHER_REFERENCE = Prisma.sql`
  NOT EXISTS (
    SELECT 1 FROM "artifact_files" f
    JOIN "artifacts" a ON a."id" = f."artifactId"
    WHERE f."sha256" = b."sha256" AND a."workspaceId" = b."workspaceId")
  AND NOT EXISTS (
    SELECT 1 FROM "artifact_comment_images" i
    JOIN "artifacts" a ON a."id" = i."artifactId"
    WHERE i."sha256" = b."sha256" AND a."workspaceId" = b."workspaceId")
  AND NOT EXISTS (
    SELECT 1 FROM "artifact_page_assets" p
    JOIN "artifacts" a ON a."id" = p."artifactId"
    WHERE p."sha256" = b."sha256" AND a."workspaceId" = b."workspaceId")`;

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

const actorKey = (actor: ArtifactActor) => commentColumns(actor).key;
