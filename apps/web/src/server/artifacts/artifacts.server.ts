import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";

/** Where an artifact lives; its home is its only access rule. */
export type ArtifactHome =
  | { kind: "conversation"; conversationId: string }
  | { kind: "workspace" }
  | { kind: "public" };

export type ArtifactActor = { userId?: string; agentId?: string };

/** One file a push adds or replaces: bytes already uploaded under `sha256`. */
export type ArtifactFileInput = {
  path: string;
  sha256: string;
  sizeBytes: number;
  kind: string;
};

/** Content-addressed storage of artifact bytes, shared by every version. */
export interface ArtifactBlobStore {
  has(workspaceId: string, sha256: string): Promise<boolean>;
}

const NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const KINDS = new Set(["html", "markdown", "text", "csv", "image", "pdf", "video", "other"]);
export const ARTIFACT_TEXT_LIMIT = 16 * 1024 * 1024;
export const ARTIFACT_BINARY_LIMIT = 15 * 1024 * 1024;
export const ARTIFACT_FILE_LIMIT = 200;

export function artifactHomeKey(home: ArtifactHome): string {
  return home.kind === "conversation" ? `conversation:${home.conversationId}` : home.kind;
}

function invalid(errorId: string): never {
  throw new AppError("INVALID_INPUT", { errorId });
}

function actorColumns(actor: ArtifactActor) {
  return actor.agentId
    ? { authorAgentId: actor.agentId, authorUserId: null }
    : { authorUserId: actor.userId ?? null, authorAgentId: null };
}

/**
 * Versioned artifacts: create, push a new immutable version, and read one. A push sends only
 * changed files; unlisted files carry over from its base version. Content lives in
 * content-addressed blobs, and this module only records which bytes a version uses.
 */
export class Artifacts {
  constructor(
    private readonly db: PrismaClient,
    private readonly blobs: ArtifactBlobStore,
  ) {}

  async create(input: {
    workspaceId: string;
    home: ArtifactHome;
    name: string;
    title?: string;
    description?: string;
    kind: string;
    entryPath: string;
    author: ArtifactActor;
  }) {
    if (!NAME.test(input.name)) invalid("artifact-name");
    if (!KINDS.has(input.kind)) invalid("artifact-kind");
    if (input.description && input.description.length > 1000) invalid("artifact-description");
    const duplicate = await this.db.artifact.findUnique({
      where: {
        workspaceId_homeKey_name: {
          workspaceId: input.workspaceId,
          homeKey: artifactHomeKey(input.home),
          name: input.name,
        },
      },
      select: { id: true },
    });
    if (duplicate) throw new AppError("CONFLICT", { errorId: "artifact-name-taken" });
    return this.db.artifact.create({
      data: {
        workspaceId: input.workspaceId,
        homeKey: artifactHomeKey(input.home),
        name: input.name,
        title: input.title ?? "",
        description: input.description ?? "",
        kind: input.kind,
        entryPath: input.entryPath,
        ...actorColumns(input.author),
      },
    });
  }

  async push(input: {
    workspaceId: string;
    artifactId: string;
    baseVersion: number;
    publisher: ArtifactActor;
    idempotencyKey: string;
    note?: string;
    label?: string;
    entryPath?: string;
    files?: readonly ArtifactFileInput[];
    deletedPaths?: readonly string[];
  }): Promise<
    | { status: "created"; versionId: string; number: number }
    | { status: "replayed"; versionId: string; number: number }
    | { status: "missing"; missing: string[] }
  > {
    const artifact = await this.db.artifact.findFirst({
      where: { id: input.artifactId, workspaceId: input.workspaceId, deletedAt: null },
      select: { id: true, currentVersion: true, entryPath: true, kind: true },
    });
    if (!artifact) throw new AppError("NOT_FOUND");

    const replay = await this.db.artifactVersion.findUnique({
      where: {
        artifactId_idempotencyKey: {
          artifactId: artifact.id,
          idempotencyKey: input.idempotencyKey,
        },
      },
      select: { id: true, number: true },
    });
    if (replay) return { status: "replayed", versionId: replay.id, number: replay.number };

    if (input.baseVersion !== artifact.currentVersion)
      throw new AppError("CONFLICT", { errorId: "artifact-base-moved" });

    const added = [...(input.files ?? [])];
    const deleted = new Set(input.deletedPaths ?? []);
    if (added.length + deleted.size > ARTIFACT_FILE_LIMIT) invalid("artifact-too-many-files");
    for (const file of added) {
      if (!file.path || file.path.startsWith("/") || file.path.includes(".."))
        invalid("artifact-file-path");
      const limit = file.kind === "text" ? ARTIFACT_TEXT_LIMIT : ARTIFACT_BINARY_LIMIT;
      if (file.sizeBytes > limit) invalid("artifact-file-too-large");
    }
    const missing: string[] = [];
    for (const file of added)
      if (!(await this.blobs.has(input.workspaceId, file.sha256))) missing.push(file.sha256);
    if (missing.length) return { status: "missing", missing: [...new Set(missing)] };

    const inherited =
      input.baseVersion > 0
        ? await this.db.artifactFile.findMany({
            where: { versionId: await this.versionId(artifact.id, input.baseVersion) },
            select: { path: true, sha256: true, sizeBytes: true, kind: true },
          })
        : [];
    const files = new Map(inherited.map((file) => [file.path, file]));
    for (const path of deleted) files.delete(path);
    for (const file of added) files.set(file.path, file);
    if (!files.size) invalid("artifact-no-files");
    const entryPath = input.entryPath ?? artifact.entryPath;
    if (!files.has(entryPath)) invalid("artifact-entry-missing");

    const created = await this.db.$transaction(async (tx) => {
      const version = await tx.artifactVersion.create({
        data: {
          artifactId: artifact.id,
          number: artifact.currentVersion + 1,
          ...(input.publisher.agentId
            ? { publisherAgentId: input.publisher.agentId, publisherUserId: null }
            : { publisherUserId: input.publisher.userId ?? null, publisherAgentId: null }),
          note: input.note ?? "",
          label: input.label ?? "",
          entryPath,
          changedPaths: {
            added: added.map((file) => file.path),
            deleted: [...deleted],
          } satisfies Prisma.InputJsonObject,
          idempotencyKey: input.idempotencyKey,
        },
        select: { id: true, number: true },
      });
      await tx.artifactFile.createMany({
        data: [...files.values()].map((file) => ({
          versionId: version.id,
          artifactId: artifact.id,
          path: file.path,
          sha256: file.sha256,
          sizeBytes: file.sizeBytes,
          kind: file.kind,
        })),
      });
      await tx.artifact.update({
        where: { id: artifact.id },
        data: { currentVersion: version.number, entryPath },
      });
      return version;
    });
    return { status: "created", versionId: created.id, number: created.number };
  }

  async read(input: { workspaceId: string; artifactId: string; version?: number }) {
    const artifact = await this.db.artifact.findFirst({
      where: { id: input.artifactId, workspaceId: input.workspaceId, deletedAt: null },
      select: {
        id: true,
        name: true,
        title: true,
        description: true,
        kind: true,
        entryPath: true,
        homeKey: true,
        currentVersion: true,
      },
    });
    if (!artifact) throw new AppError("NOT_FOUND");
    const number = input.version ?? artifact.currentVersion;
    if (number <= 0) return { artifact, version: null, files: [] };
    const version = await this.db.artifactVersion.findUnique({
      where: { artifactId_number: { artifactId: artifact.id, number } },
      select: { id: true, number: true, note: true, label: true, entryPath: true, createdAt: true },
    });
    if (!version) throw new AppError("NOT_FOUND");
    const files = await this.db.artifactFile.findMany({
      where: { versionId: version.id },
      select: { path: true, sha256: true, sizeBytes: true, kind: true },
      orderBy: { path: "asc" },
    });
    return { artifact, version, files };
  }

  private async versionId(artifactId: string, number: number) {
    const version = await this.db.artifactVersion.findUnique({
      where: { artifactId_number: { artifactId, number } },
      select: { id: true },
    });
    if (!version) throw new AppError("CONFLICT", { errorId: "artifact-base-missing" });
    return version.id;
  }
}
