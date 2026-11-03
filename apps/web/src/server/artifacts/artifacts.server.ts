import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import {
  artifactHomeAccess,
  artifactsDisabled,
  artifactsEnabled,
  canDeleteArtifact,
  type ArtifactActor,
} from "./artifact-access.server";
import {
  ARTIFACT_SETTINGS,
  mergeSettings,
  type ArtifactConflict,
  type ArtifactSettingName,
  type ArtifactSettings,
} from "./artifact-merge.server";

/** Where an artifact lives; its home is its only access rule. */
export type ArtifactHome =
  | { kind: "conversation"; conversationId: string }
  | { kind: "workspace" }
  | { kind: "public" };

export type { ArtifactActor };

/** One file a push adds or replaces: bytes already uploaded under `sha256`. Its size and kind
 * come from the blob, never from the client. */
export type ArtifactFileInput = {
  path: string;
  sha256: string;
};

/** What a stored blob is: its size and the kind the server derived from the bytes. */
export type ArtifactBlobInfo = { sizeBytes: number; kind: string };

/** Content-addressed storage of artifact bytes, shared by every version. */
export interface ArtifactBlobStore {
  /** One lookup for every sha256 a push names; a blob that is not stored is absent. */
  inspectMany(
    workspaceId: string,
    sha256s: readonly string[],
  ): Promise<Map<string, ArtifactBlobInfo>>;
  /** Marks the blobs a save names as used, in the save's transaction; returns those no longer
   * stored. */
  use(
    tx: Prisma.TransactionClient,
    workspaceId: string,
    sha256s: readonly string[],
  ): Promise<string[]>;
}

const NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const KINDS = new Set(["html", "markdown", "text", "csv", "image", "pdf", "video", "other"]);
export const ARTIFACT_TEXT_LIMIT = 16 * 1024 * 1024;
export const ARTIFACT_BINARY_LIMIT = 15 * 1024 * 1024;
export const ARTIFACT_FILE_LIMIT = 200;
export const ARTIFACT_NOTE_LIMIT = 500;
export const ARTIFACT_LABEL_LIMIT = 60;
/** A document's (a `markdown` artifact's) own file: what a person edits in one page. */
export const ARTIFACT_DOCUMENT_LIMIT = 2 * 1024 * 1024;

export function artifactHomeKey(home: ArtifactHome): string {
  return home.kind === "conversation" ? `conversation:${home.conversationId}` : home.kind;
}

function invalid(errorId: string): never {
  throw new AppError("INVALID_INPUT", { errorId });
}

function actorColumns(actor: ArtifactActor) {
  return actor.agentId
    ? { authorAgentId: actor.agentId, authorUserId: null }
    : { authorUserId: actor.userId, authorAgentId: null };
}

/**
 * A file path as segments: no empty segment (`a//b`, a trailing `/`), no `.`/`..`, no backslash,
 * no control character, nothing absolute. `a..b.txt` is a normal name and passes.
 */
export function artifactPathValid(path: string): boolean {
  if (!path || path.startsWith("/") || path.endsWith("/")) return false;
  return path
    .split("/")
    .every(
      (segment) =>
        segment.length > 0 &&
        segment !== "." &&
        segment !== ".." &&
        !/[\\:\u0000-\u001f\u007f]/.test(segment),
    );
}

/** The server's own reading of a file's kind, from its extension; the client cannot choose it. */
export function artifactKindOfPath(path: string): string {
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  if (["html", "htm"].includes(extension)) return "html";
  if (["md", "markdown"].includes(extension)) return "markdown";
  if (["txt", "log"].includes(extension)) return "text";
  if (extension === "csv") return "csv";
  if (["png", "jpg", "jpeg", "gif", "webp", "avif", "svg"].includes(extension)) return "image";
  if (extension === "pdf") return "pdf";
  if (["mp4", "webm", "mov"].includes(extension)) return "video";
  return "other";
}

type FileRow = { path: string; sha256: string; sizeBytes: number; kind: string };

/**
 * Versioned artifacts: create, push a new immutable version, and read one. A push sends only
 * changed files; unlisted files carry over from its base version — and when the artifact moved on,
 * a push over an older base is merged with the others' changes unless it touched the same file.
 * Content lives in content-addressed blobs, and this module only records which bytes a version
 * uses.
 */
export class Artifacts {
  private readonly enabled: (workspaceId: string) => Promise<boolean>;

  constructor(
    private readonly db: PrismaClient,
    private readonly blobs: ArtifactBlobStore,
    /** Whether the Workspace has the `artifacts` experiment on; every operation asks first. */
    options: { enabled?: (workspaceId: string) => Promise<boolean> } = {},
  ) {
    this.enabled = options.enabled ?? ((workspaceId) => artifactsEnabled(db, workspaceId));
  }

  /** The actor's access to a home: `NOT_FOUND` where it cannot read, as if nothing were there,
   * and `ACCESS_DENIED` where it reads but may not write. */
  private async requireHome(
    workspaceId: string,
    actor: ArtifactActor,
    homeKey: string,
    need: "read" | "write",
  ) {
    const access = await artifactHomeAccess(this.db, workspaceId, actor, homeKey);
    if (!access.read) throw new AppError("NOT_FOUND");
    if (need === "write" && !access.write) throw new AppError("ACCESS_DENIED");
  }

  /** A live artifact's home and author, after the experiment check: what every access needs. */
  private async live(workspaceId: string, artifactId: string) {
    if (!(await this.enabled(workspaceId))) throw artifactsDisabled();
    const artifact = await this.db.artifact.findFirst({
      where: { id: artifactId, workspaceId, deletedAt: null },
      select: { homeKey: true, authorUserId: true, authorAgentId: true },
    });
    if (!artifact) throw new AppError("NOT_FOUND");
    return artifact;
  }

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
    // The experiment first: a Workspace without it hears only that, whatever it sent.
    if (!(await this.enabled(input.workspaceId))) throw artifactsDisabled();
    if (!NAME.test(input.name)) invalid("artifact-name");
    if (!KINDS.has(input.kind)) invalid("artifact-kind");
    if (input.description && input.description.length > 1000) invalid("artifact-description");
    // Anyone with the link is a home a later step adds, with its own switch and refusals.
    if (input.home.kind === "public") invalid("artifact-home");
    await this.requireHome(input.workspaceId, input.author, artifactHomeKey(input.home), "write");
    try {
      return await this.db.artifact.create({
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
    } catch (error) {
      // The live-name unique index is the authority: a soft-deleted row releases the name.
      if (isUniqueViolation(error))
        throw new AppError("CONFLICT", { errorId: "artifact-name-taken" });
      throw error;
    }
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
    title?: string;
    description?: string;
    files?: readonly ArtifactFileInput[];
    deletedPaths?: readonly string[];
  }): Promise<
    | {
        status: "created";
        versionId: string;
        number: number;
        merged: string[];
        mergedSettings: ArtifactSettingName[];
      }
    | { status: "replayed"; versionId: string; number: number }
    | { status: "nothing" }
    | { status: "missing"; missing: string[] }
    | ArtifactConflict
  > {
    const { homeKey } = await this.live(input.workspaceId, input.artifactId);
    if ((input.note?.length ?? 0) > ARTIFACT_NOTE_LIMIT) invalid("artifact-note");
    if ((input.label?.length ?? 0) > ARTIFACT_LABEL_LIMIT) invalid("artifact-label");
    await this.requireHome(input.workspaceId, input.publisher, homeKey, "write");
    const added = [...(input.files ?? [])];
    const deleted = [...new Set(input.deletedPaths ?? [])];
    for (const file of added) if (!artifactPathValid(file.path)) invalid("artifact-file-path");
    for (const path of deleted) if (!artifactPathValid(path)) invalid("artifact-file-path");
    if (new Set(added.map((file) => file.path)).size !== added.length)
      invalid("artifact-file-path");
    if (added.some((file) => deleted.includes(file.path))) invalid("artifact-file-path");

    // The bytes are checked before the lock: a missing blob is a 200 the client uploads and retries.
    const blobs = await this.blobs.inspectMany(input.workspaceId, [
      ...new Set(added.map((file) => file.sha256)),
    ]);
    const missing = [...new Set(added.map((file) => file.sha256))].filter(
      (sha256) => !blobs.has(sha256),
    );
    if (missing.length) return { status: "missing", missing };
    for (const file of added) {
      const blob = blobs.get(file.sha256)!;
      const limit = blob.kind === "text" ? ARTIFACT_TEXT_LIMIT : ARTIFACT_BINARY_LIMIT;
      if (blob.sizeBytes > limit) invalid("artifact-file-too-large");
    }

    return this.db.$transaction(async (tx) => {
      // Serialize every push for this artifact: the base check, the replay check and the version
      // number are decided under one row lock, so a concurrent push cannot slip between them.
      const [locked] = await tx.$queryRaw<
        {
          id: string;
          currentVersion: number;
          entryPath: string;
          title: string;
          description: string;
          kind: string;
        }[]
      >`SELECT "id", "currentVersion", "entryPath", "title", "description", "kind"
         FROM "artifacts"
         WHERE "id" = ${input.artifactId}::uuid AND "workspaceId" = ${input.workspaceId}::uuid
           AND "deletedAt" IS NULL
         FOR UPDATE`;
      if (!locked) throw new AppError("NOT_FOUND");
      const current = locked.currentVersion;

      const replay = await tx.artifactVersion.findUnique({
        where: {
          artifactId_idempotencyKey: {
            artifactId: locked.id,
            idempotencyKey: input.idempotencyKey,
          },
        },
        select: { id: true, number: true },
      });
      if (replay)
        return { status: "replayed", versionId: replay.id, number: replay.number } as const;

      if (input.baseVersion > current || input.baseVersion < 0)
        throw new AppError("CONFLICT", { errorId: "artifact-base-moved" });

      // A version's files, and the settings it recorded; before the first version, none of either.
      const versionAt = async (number: number) => {
        if (number <= 0) return { files: new Map<string, FileRow>(), settings: null };
        const version = await tx.artifactVersion.findUnique({
          where: { artifactId_number: { artifactId: locked.id, number } },
          select: { id: true, title: true, description: true, entryPath: true },
        });
        if (!version) throw new AppError("CONFLICT", { errorId: "artifact-base-missing" });
        const rows = await tx.artifactFile.findMany({
          where: { versionId: version.id },
          select: { path: true, sha256: true, sizeBytes: true, kind: true },
        });
        const { title, description, entryPath } = version;
        return {
          files: new Map(rows.map((row) => [row.path, row])),
          settings: { title, description, entryPath } as ArtifactSettings,
        };
      };
      const currentFiles = (await versionAt(current)).files;
      const currentSettings: ArtifactSettings = {
        title: locked.title,
        description: locked.description,
        entryPath: locked.entryPath,
      };
      const base =
        input.baseVersion === current
          ? { files: currentFiles, settings: currentSettings }
          : await versionAt(input.baseVersion);
      const baseFiles = base.files;
      const settings = mergeSettings(base.settings, currentSettings, {
        ...(input.title !== undefined && { title: input.title }),
        ...(input.description !== undefined && { description: input.description }),
        ...(input.entryPath !== undefined && { entryPath: input.entryPath }),
      });
      if (settings.conflicts.length)
        return {
          status: "conflict",
          currentVersion: current,
          files: [],
          settings: settings.conflicts,
        } as const;

      // Deleting something the push's own base never held is a mistake, not a no-op.
      for (const path of deleted) if (!baseFiles.has(path)) invalid("artifact-file-path");

      // What others changed between the push's base and the current version.
      const othersChanged = new Set<string>();
      if (input.baseVersion < current) {
        for (const path of new Set([...baseFiles.keys(), ...currentFiles.keys()])) {
          const before = baseFiles.get(path);
          const now = currentFiles.get(path);
          if (before?.sha256 !== now?.sha256) othersChanged.add(path);
        }
        // The same file touched on both sides cannot be merged without a human.
        for (const path of [...added.map((file) => file.path), ...deleted])
          if (othersChanged.has(path))
            throw new AppError("CONFLICT", { errorId: "artifact-base-moved" });
      }

      const result = new Map(currentFiles);
      for (const path of deleted) result.delete(path);
      for (const file of added) {
        const blob = blobs.get(file.sha256)!;
        result.set(file.path, {
          path: file.path,
          sha256: file.sha256,
          sizeBytes: blob.sizeBytes,
          kind: blob.kind,
        });
      }
      if (result.size > ARTIFACT_FILE_LIMIT) invalid("artifact-too-many-files");
      const { entryPath, title, description } = settings.result;
      if (result.size && !result.has(entryPath)) invalid("artifact-entry-missing");
      if (
        locked.kind === "markdown" &&
        (result.get(entryPath)?.sizeBytes ?? 0) > ARTIFACT_DOCUMENT_LIMIT
      )
        invalid("artifact-file-too-large");

      const merged = [...othersChanged].sort();
      const settingsChanged = ARTIFACT_SETTINGS.some(
        (name) => settings.result[name] !== currentSettings[name],
      );
      if (added.length === 0 && deleted.length === 0 && !settingsChanged)
        // Nothing of the pusher's own: "Nothing to push", even when others moved the artifact.
        return { status: "nothing" } as const;
      // In this transaction, so the sweep of unused blobs leaves them; one it removed since the
      // inspection above is uploaded again.
      const gone = await this.blobs.use(tx, input.workspaceId, [
        ...new Set(added.map((file) => file.sha256)),
      ]);
      if (gone.length) return { status: "missing", missing: gone } as const;

      const version = await tx.artifactVersion.create({
        data: {
          artifactId: locked.id,
          number: current + 1,
          ...(input.publisher.agentId
            ? { publisherAgentId: input.publisher.agentId, publisherUserId: null }
            : { publisherUserId: input.publisher.userId ?? null, publisherAgentId: null }),
          note: input.note ?? "",
          label: input.label ?? "",
          entryPath,
          title,
          description,
          changedPaths: {
            added: added.map((file) => file.path),
            deleted,
          } satisfies Prisma.InputJsonObject,
          ...(merged.length ? { merged: merged as Prisma.InputJsonValue } : {}),
          idempotencyKey: input.idempotencyKey,
        },
        select: { id: true, number: true },
      });
      await tx.artifactFile.createMany({
        data: [...result.values()].map((file) => ({
          versionId: version.id,
          artifactId: locked.id,
          path: file.path,
          sha256: file.sha256,
          sizeBytes: file.sizeBytes,
          kind: file.kind,
        })),
      });
      await tx.artifact.update({
        where: { id: locked.id },
        data: {
          currentVersion: version.number,
          entryPath,
          title,
          description,
        },
      });
      return {
        status: "created",
        versionId: version.id,
        number: version.number,
        merged,
        mergedSettings: settings.merged,
      } as const;
    });
  }

  /** Soft-deletes the artifact (its name is free again at once); its author's, or a Workspace
   * owner's or admin's, among those who can read it. An Agent deletes only its own. */
  async delete(input: { workspaceId: string; artifactId: string; actor: ArtifactActor }) {
    const artifact = await this.live(input.workspaceId, input.artifactId);
    await this.requireHome(input.workspaceId, input.actor, artifact.homeKey, "read");
    if (!(await canDeleteArtifact(this.db, input.workspaceId, input.actor, artifact)))
      throw new AppError("ACCESS_DENIED");
    await this.db.artifact.updateMany({
      where: { id: input.artifactId, workspaceId: input.workspaceId, deletedAt: null },
      data: {
        deletedAt: new Date(),
        ...(input.actor.agentId
          ? { deletedByAgentId: input.actor.agentId }
          : { deletedByUserId: input.actor.userId }),
      },
    });
  }

  async read(input: {
    workspaceId: string;
    artifactId: string;
    reader: ArtifactActor;
    version?: number;
  }) {
    if (!(await this.enabled(input.workspaceId))) throw artifactsDisabled();
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
    await this.requireHome(input.workspaceId, input.reader, artifact.homeKey, "read");
    const number = input.version ?? artifact.currentVersion;
    if (number <= 0) return { artifact, version: null, files: [] };
    const version = await this.db.artifactVersion.findUnique({
      where: { artifactId_number: { artifactId: artifact.id, number } },
      select: {
        id: true,
        number: true,
        note: true,
        label: true,
        entryPath: true,
        title: true,
        description: true,
        merged: true,
        createdAt: true,
      },
    });
    if (!version) throw new AppError("NOT_FOUND");
    const files = await this.db.artifactFile.findMany({
      where: { versionId: version.id },
      select: { path: true, sha256: true, sizeBytes: true, kind: true },
      orderBy: { path: "asc" },
    });
    return { artifact, version, files };
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}
