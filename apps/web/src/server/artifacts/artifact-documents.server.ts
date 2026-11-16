import { createHash } from "node:crypto";
import type { PrismaClient } from "#src/generated/prisma/client";
import { AppError, isAppError } from "#src/lib/app-error";
import { nameToSlug } from "#src/lib/slug";
import { errorType } from "#src/server/errors/error-type.server";
import {
  canDeleteArtifactWithRole,
  type ArtifactActor,
  type ArtifactPublisher,
} from "./artifact-access.server";
import type { StoredArtifactBlobs } from "./artifact-blobs.server";
import { artifactOpenableKind } from "#src/features/artifacts/artifact-path-kind";
import { ARTIFACT_TITLE_MAX } from "#src/features/artifacts/artifact-title-limit";
import { ARTIFACT_ENTRY_READ_LIMIT } from "./artifact-files.server";
import { planManifestCreate, type FileManifest } from "./artifact-manifest.server";
import type { Artifacts } from "./artifacts.server";

const FALLBACK_NAME = "artifact";
const SEQUENTIAL_NAMES = 3;
const NAME_TRIES = 8;

export type DocumentScope = { workspaceId: string; actor: ArtifactActor };

export type WriteScope = { workspaceId: string; actor: ArtifactPublisher };

export class ArtifactDocuments {
  constructor(
    private readonly db: PrismaClient,
    private readonly artifacts: Artifacts,
    private readonly blobs: Pick<StoredArtifactBlobs, "read" | "inspectMany" | "allowed">,
  ) {}

  async create(
    scope: WriteScope,
    input: {
      conversationId: string;
      title: string;
      description?: string;
      manifest: FileManifest;
      idempotencyKey?: string;
      origin?: { messageId: string; attachmentId: string };
    },
  ) {
    const plan = planManifestCreate(input.manifest);
    const title = input.title.trim();
    if (!title || [...title].length > ARTIFACT_TITLE_MAX)
      throw new AppError("INVALID_INPUT", { errorId: "artifact-title" });
    const description = input.description?.trim() ?? "";
    const home = { kind: "conversation", conversationId: input.conversationId } as const;
    const requestHash =
      input.idempotencyKey === undefined
        ? undefined
        : createRequestHash({
            homeKey: `conversation:${input.conversationId}`,
            title,
            description,
            ...plan,
          });
    const base = nameToSlug(title, 56) || FALLBACK_NAME;
    for (let attempt = 1; ; attempt += 1) {
      const name =
        attempt === 1
          ? base
          : attempt <= SEQUENTIAL_NAMES
            ? `${base}-${attempt}`
            : `${base}-${crypto.randomUUID().slice(0, 6)}`;
      let previewed = false;
      try {
        const created = await this.artifacts.create({
          workspaceId: scope.workspaceId,
          home,
          name,
          title,
          ...(description ? { description } : {}),
          ...(input.origin ? { origin: input.origin } : {}),
          entryPath: plan.entryPath,
          author: scope.actor,
          ...(input.idempotencyKey !== undefined
            ? { idempotencyKey: input.idempotencyKey, requestHash }
            : {}),
          version: {
            files: plan.files,
            idempotencyKey:
              input.idempotencyKey === undefined
                ? crypto.randomUUID()
                : `${input.idempotencyKey}:v1`,
          },
          beforeAnnounce: async (artifactId) => {
            previewed = true;
            await this.#refreshPreview(scope, artifactId);
          },
        });
        if (!previewed) await this.#refreshPreview(scope, created.id);
        return (
          await this.artifacts.reads.cards({ ...reader(scope), artifactIds: [created.id] })
        )[0]!;
      } catch (error) {
        const taken = isAppError(error) && error.errorId === "artifact-name-taken";
        if (!taken || attempt >= NAME_TRIES) throw error;
      }
    }
  }

  async missingBytes(scope: WriteScope, input: { manifest: FileManifest }): Promise<string[]> {
    const { files } = planManifestCreate(input.manifest);
    const named = [...new Set(files.map((file) => file.sha256))];
    const [stored, granted] = await Promise.all([
      this.blobs.inspectMany(scope.workspaceId, named),
      this.blobs.allowed(scope.workspaceId, undefined, scope.actor, named),
    ]);
    return named.filter((sha256) => !stored.has(sha256) || !granted.has(sha256));
  }

  async load(
    scope: DocumentScope,
    input: { artifactId: string; version?: number },
    options?: { body?: "entry" | "markdown" },
  ) {
    const { viewer, authorAgentOwnerId, ...read } = await this.artifacts.reads.read({
      ...reader(scope),
      ...input,
    });
    const entryPath = read.version?.entryPath ?? read.artifact.entryPath;
    const file = read.files.find((entry) => entry.path === entryPath);
    const document = artifactOpenableKind(entryPath) === "markdown";
    const readable =
      file?.kind === "text" &&
      file.sizeBytes <= ARTIFACT_ENTRY_READ_LIMIT &&
      (options?.body !== "markdown" || document);
    const bytes = readable ? await this.blobs.read(scope.workspaceId, file.sha256) : null;
    const canDelete =
      canDeleteArtifactWithRole(scope.actor, viewer.role, read.artifact) ||
      (scope.actor.userId !== undefined && authorAgentOwnerId === scope.actor.userId);
    return {
      ...read,
      text: bytes ? new TextDecoder().decode(bytes) : "",
      canDelete,
    };
  }

  async push(
    scope: WriteScope,
    input: {
      artifactId: string;
      baseVersion: number;
      idempotencyKey: string;
      manifest?: FileManifest;
      title?: string;
      description?: string;
      note?: string;
      label?: string;
    },
    options?: { afterSave?: (saved: { number: number }) => Promise<void> },
  ) {
    const { manifest, ...settings } = input;
    let tailError: { error: unknown } | undefined;
    const saved = await this.artifacts.push({
      workspaceId: scope.workspaceId,
      publisher: scope.actor,
      ...(manifest?.files && { files: manifest.files }),
      ...(manifest?.deletedPaths && { deletedPaths: manifest.deletedPaths }),
      ...(manifest?.entryPath !== undefined && { entryPath: manifest.entryPath }),
      ...settings,
      beforeAnnounce: async (created) => {
        await Promise.all([
          created.previewStale ? this.#refreshPreview(scope, input.artifactId) : undefined,
          options?.afterSave?.(created)?.catch((error: unknown) => {
            tailError = { error };
          }),
        ]);
      },
    });
    if (tailError) throw tailError.error;
    if (saved.status === "replayed") await options?.afterSave?.(saved);
    return saved;
  }

  async remove(scope: WriteScope, input: { artifactId: string }) {
    return this.artifacts.delete({ ...scope, ...input });
  }

  moveToWorkspace(scope: WriteScope, input: { artifactId: string }) {
    return this.artifacts.visibility.moveToWorkspace({
      workspaceId: scope.workspaceId,
      artifactId: input.artifactId,
      agentId: scope.actor.agentId,
    });
  }

  list(scope: DocumentScope, input: { conversationId?: string }) {
    return this.artifacts.reads.list({ ...reader(scope), ...input });
  }

  listPage(
    scope: DocumentScope,
    input: {
      conversationId?: string;
      query?: string;
      title?: string;
      cursor?: string;
      limit: number;
    },
  ) {
    return this.artifacts.reads.listPage({ ...reader(scope), ...input });
  }

  cards(scope: DocumentScope, artifactIds: readonly string[]) {
    return this.artifacts.reads.cards({ ...reader(scope), artifactIds });
  }

  async #refreshPreview(scope: { workspaceId: string }, artifactId: string) {
    try {
      await refreshPreview(this.db, this.blobs, scope.workspaceId, artifactId);
    } catch (error) {
      console.warn(
        JSON.stringify({ event: "artifacts:preview_failed", error_type: errorType(error) }),
      );
    }
  }
}

function createRequestHash(input: {
  homeKey: string;
  title: string;
  description: string;
  entryPath: string;
  files: readonly { path: string; sha256: string }[];
}): string {
  const parts = JSON.stringify([
    input.homeKey,
    input.title,
    input.description,
    input.entryPath,
    input.files.map((file) => [file.path, file.sha256]).sort(),
  ]);
  return createHash("sha256").update(parts).digest("hex");
}

const reader = (scope: DocumentScope) => ({ workspaceId: scope.workspaceId, reader: scope.actor });

const PREVIEW_LINES = 12;
const PREVIEW_CHARACTERS = 600;

function artifactPreview(text: string): string {
  return text
    .trim()
    .split("\n")
    .slice(0, PREVIEW_LINES)
    .join("\n")
    .slice(0, PREVIEW_CHARACTERS)
    .trim();
}

async function refreshPreview(
  db: PrismaClient,
  blobs: Pick<StoredArtifactBlobs, "read">,
  workspaceId: string,
  artifactId: string,
) {
  const artifact = await db.artifact.findFirst({
    where: { id: artifactId, workspaceId, deletedAt: null },
    select: { currentVersion: true, entryPath: true, description: true },
  });
  if (!artifact || artifact.currentVersion <= 0) return;
  const kind = artifactOpenableKind(artifact.entryPath);
  if (kind === "html") {
    await db.artifact.updateMany({
      where: { id: artifactId, currentVersion: artifact.currentVersion },
      data: { preview: artifactPreview(artifact.description) },
    });
    return;
  }
  if (kind !== "markdown") {
    await db.artifact.updateMany({
      where: { id: artifactId, currentVersion: artifact.currentVersion },
      data: { preview: "" },
    });
    return;
  }
  const file = await db.artifactFile.findFirst({
    where: {
      artifactId,
      path: artifact.entryPath,
      kind: "text",
      version: { number: artifact.currentVersion },
    },
    select: { sha256: true, sizeBytes: true },
  });
  const bytes =
    file && file.sizeBytes <= ARTIFACT_ENTRY_READ_LIMIT
      ? await blobs.read(workspaceId, file.sha256)
      : null;
  await db.artifact.updateMany({
    where: { id: artifactId, currentVersion: artifact.currentVersion },
    data: { preview: bytes ? artifactPreview(new TextDecoder().decode(bytes)) : "" },
  });
}
