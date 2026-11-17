import type { Artifact, PrismaClient } from "#src/generated/prisma/client";
import { artifactOpenableKind } from "#src/features/artifacts/artifact-path-kind";
import { AppError } from "#src/lib/app-error";
import { isUniqueViolation } from "#src/server/db/unique-violation.server";
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

const NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export type CreateArtifactInput = {
  workspaceId: string;
  homeKey: string;
  name: string;
  title?: string;
  description?: string;
  entryPath: string;
  author: ArtifactPublisher;
  idempotencyKey?: string;
  requestHash?: string;
  origin?: { messageId: string; attachmentId: string };
};

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
      ...(input.origin
        ? { originMessageId: input.origin.messageId, originAttachmentId: input.origin.attachmentId }
        : {}),
      ...(input.idempotencyKey !== undefined
        ? { idempotencyKey: input.idempotencyKey, requestHash: input.requestHash ?? null }
        : {}),
    },
  });
}

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
  const entryFile = files.find((file) => file.path === input.entryPath);
  if (
    entryFile !== undefined &&
    artifactOpenableKind(input.entryPath) !== null &&
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
    if (isUniqueViolation(error) && input.idempotencyKey !== undefined) {
      const replay = await createReplay(
        db,
        input.workspaceId,
        input.idempotencyKey,
        input.requestHash,
      );
      if (replay) return { artifact: replay, fresh: false };
    }
    if (isUniqueViolation(error))
      throw new AppError("CONFLICT", { errorId: "artifact-name-taken" });
    throw error;
  }
}

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

function invalid(errorId: string): never {
  throw new AppError("INVALID_INPUT", { errorId });
}
