import type { Artifact, PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import type { ArtifactPublisher } from "./artifact-access.server";
import { idempotencyMismatch } from "./artifact-idempotency.server";
import {
  ARTIFACT_BINARY_LIMIT,
  ARTIFACT_ENTRY_READ_LIMIT,
  ARTIFACT_TEXT_LIMIT,
  type ArtifactBlobStore,
  type ArtifactFileInput,
} from "./artifact-files.server";
import { writeVersion } from "./artifact-version-write.server";

/**
 * Creating an artifact (task #385): the one insert, with idempotent-create replay on top. A
 * create that carries a key the Workspace already used returns the artifact it made (replay)
 * when the inputs match, and is a conflict when they differ, so a lost response on the first
 * try does not leave a second document behind. The caller has already checked the experiment,
 * the name and the home.
 */

const NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export type CreateArtifactInput = {
  workspaceId: string;
  homeKey: string;
  name: string;
  title?: string;
  description?: string;
  entryPath: string;
  author: ArtifactPublisher;
  /** An idempotent create: the client's key, and a hash of this create's inputs. The same key
   * with the same hash returns the artifact already made; with a different hash it is a
   * conflict. */
  idempotencyKey?: string;
  requestHash?: string;
};

/** Validates the name and description, then inserts the artifact row. */
export async function createArtifact(
  db: Pick<PrismaClient, "artifact">,
  input: CreateArtifactInput,
): Promise<Artifact> {
  if (!NAME.test(input.name)) invalid("artifact-name");
  if (input.description && input.description.length > 1000) invalid("artifact-description");
  return db.artifact.create({
    data: {
      workspaceId: input.workspaceId,
      homeKey: input.homeKey,
      name: input.name,
      title: input.title ?? "",
      description: input.description ?? "",
      entryPath: input.entryPath,
      authorAgentId: input.author.agentId,
      ...(input.idempotencyKey !== undefined
        ? { idempotencyKey: input.idempotencyKey, requestHash: input.requestHash ?? null }
        : {}),
    },
  });
}

/**
 * A create and, given `version`, its version 1 in one transaction (task #25): the row, its
 * files and its idempotent replay land together or not at all, and version 1 never meets the
 * comment gate — no comment can exist on an artifact not yet made. Missing or ungranted bytes
 * refuse the whole create before anything is written, so no artifact row is left without its
 * version. `fresh` is false on an idempotent replay.
 */
export async function createVersionedArtifact(
  db: PrismaClient,
  blobs: ArtifactBlobStore,
  input: CreateArtifactInput & {
    version?: { files: readonly ArtifactFileInput[]; idempotencyKey: string };
  },
): Promise<{ artifact: Artifact; fresh: boolean }> {
  const files = input.version?.files ?? [];
  const named = [...new Set(files.map((file) => file.sha256))];
  const [stored, granted] = await Promise.all([
    blobs.inspectMany(input.workspaceId, named),
    blobs.allowed(input.workspaceId, undefined, input.author, named),
  ]);
  const missing = named.filter((sha256) => !stored.has(sha256) || !granted.has(sha256));
  if (missing.length)
    throw new AppError("TEMPORARILY_UNAVAILABLE", { errorId: "artifact-bytes-missing" });
  for (const file of files) {
    const blob = stored.get(file.sha256)!;
    const limit = blob.kind === "text" ? ARTIFACT_TEXT_LIMIT : ARTIFACT_BINARY_LIMIT;
    if (blob.sizeBytes > limit) invalid("artifact-file-too-large");
  }
  // The entry is what the page shows whole: over the read limit it would render blank.
  const entryFile = files.find((file) => file.path === input.entryPath);
  if (
    entryFile !== undefined &&
    stored.get(entryFile.sha256)!.sizeBytes > ARTIFACT_ENTRY_READ_LIMIT
  )
    invalid("artifact-entry-too-large");
  try {
    return await db.$transaction(async (tx) => {
      if (input.idempotencyKey !== undefined) {
        const replay = await createReplay(
          tx,
          input.workspaceId,
          input.idempotencyKey,
          input.requestHash,
        );
        if (replay) return { artifact: replay, fresh: false };
      }
      const artifact = await createArtifact(tx, input);
      if (input.version !== undefined) {
        // In this transaction, so the sweep of unused blobs leaves them.
        const gone = await blobs.use(tx, input.workspaceId, named);
        if (gone.length)
          throw new AppError("TEMPORARILY_UNAVAILABLE", { errorId: "artifact-bytes-missing" });
        await writeVersion(tx, {
          artifactId: artifact.id,
          number: 1,
          publisher: input.author,
          settings: {
            entryPath: artifact.entryPath,
            title: artifact.title,
            description: artifact.description,
          },
          added: files,
          deleted: [],
          merged: { files: [], settings: [] },
          idempotencyKey: input.version.idempotencyKey,
          files: files.map((file) => {
            const blob = stored.get(file.sha256)!;
            return {
              path: file.path,
              sha256: file.sha256,
              sizeBytes: blob.sizeBytes,
              kind: blob.kind,
            };
          }),
        });
      }
      return { artifact, fresh: true };
    });
  } catch (error) {
    // Two racing creates with one key: the loser reads the winner's row and replays it.
    if (
      isUniqueViolation(error, "artifacts_idempotency_key") &&
      input.idempotencyKey !== undefined
    ) {
      const replay = await createReplay(
        db,
        input.workspaceId,
        input.idempotencyKey,
        input.requestHash,
      );
      if (replay) return { artifact: replay, fresh: false };
    }
    // The live-name unique index is the authority: a soft-deleted row releases the name.
    if (isUniqueViolation(error))
      throw new AppError("CONFLICT", { errorId: "artifact-name-taken" });
    throw error;
  }
}

/** The live artifact a create's key already made, when its inputs match (replay); a different
 * `requestHash` is a conflict. Null when the key has made nothing. */
export async function createReplay(
  db: Pick<PrismaClient, "artifact">,
  workspaceId: string,
  idempotencyKey: string,
  requestHash?: string,
): Promise<Artifact | null> {
  const existing = await db.artifact.findFirst({
    where: { workspaceId, idempotencyKey, deletedAt: null },
  });
  if (!existing) return null;
  if ((existing.requestHash ?? null) !== (requestHash ?? null)) throw idempotencyMismatch();
  return existing;
}

/** Whether an error is a Postgres unique violation (P2002), optionally for a named constraint
 * (its index map name, which P2002's `meta.target` carries). */
export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  if (
    typeof error !== "object" ||
    error === null ||
    !("code" in error) ||
    (error as { code?: unknown }).code !== "P2002"
  )
    return false;
  if (constraint === undefined) return true;
  const target = (error as { meta?: { target?: unknown } }).meta?.target;
  const text = Array.isArray(target) ? target.join(",") : String(target ?? "");
  return text.includes(constraint);
}

function invalid(errorId: string): never {
  throw new AppError("INVALID_INPUT", { errorId });
}
