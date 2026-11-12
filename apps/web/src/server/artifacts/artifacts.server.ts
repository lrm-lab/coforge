import type { PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import {
  ARTIFACT_BINARY_LIMIT,
  ARTIFACT_FILE_LIMIT,
  ARTIFACT_TEXT_LIMIT,
  artifactPathValid,
  type ArtifactBlobStore,
  type ArtifactFileInput,
  type ArtifactFileRow as FileRow,
} from "./artifact-files.server";
import {
  requireArtifactHome,
  requireArtifactWrite,
  artifactsDisabled,
  artifactsEnabled,
  canDeleteArtifact,
  changeArtifactAccess,
  type ArtifactActor,
  type ArtifactPublisher,
} from "./artifact-access.server";
import {
  ARTIFACT_SETTINGS,
  mergeSettings,
  type ArtifactSettingName,
  type ArtifactSettings,
} from "./artifact-merge.server";
import { refuseOverlap, refuseUnknownBase } from "./artifact-agent-base.server";
import { createArtifact } from "./artifact-create.server";
import { requireOpenableEntry } from "./artifact-manifest.server";
import { ArtifactReads } from "./artifact-reads.server";
import { requireNoUnseenCommentsOnPush } from "./artifact-comment-gate.server";
import { lockComments } from "./artifact-comment-write.server";
import { announceVersion, type ArtifactSignals } from "./artifact-signals.server";
import { writeVersion } from "./artifact-version-write.server";

/** Where an artifact lives; its home is its only access rule. */
export type ArtifactHome =
  | { kind: "conversation"; conversationId: string }
  | { kind: "workspace" }
  | { kind: "public" };

export type { ArtifactActor, ArtifactPublisher };
export * from "./artifact-files.server";

export const ARTIFACT_NOTE_LIMIT = 500;
export const ARTIFACT_LABEL_LIMIT = 60;

export function artifactHomeKey(home: ArtifactHome): string {
  return home.kind === "conversation" ? `conversation:${home.conversationId}` : home.kind;
}

function invalid(errorId: string): never {
  throw new AppError("INVALID_INPUT", { errorId });
}

/**
 * Versioned artifacts: create, push a new immutable version, and read one. A push sends only
 * changed files; unlisted files carry over from its base version — and when the artifact moved on,
 * a push over an older base is merged with the others' changes by file, and its settings by item
 * (`artifact-merge.server.ts`); a file or setting both sides changed refuses the push
 * (`artifact-base-moved`). Content lives in content-addressed blobs, and this module only records
 * which bytes a version uses.
 */
export class Artifacts {
  private readonly enabled: (workspaceId: string) => Promise<boolean>;
  /** Reading artifacts: a version, a list and cards (`ArtifactReads`). */
  readonly reads: ArtifactReads;
  private readonly signals?: ArtifactSignals;

  constructor(
    private readonly db: PrismaClient,
    private readonly blobs: ArtifactBlobStore,
    options: {
      /** Whether the Workspace has the `artifacts` experiment on; every operation asks first. */
      enabled?: (workspaceId: string) => Promise<boolean>;
      /** Where a new version is announced, after it commits; none without it. */
      signals?: ArtifactSignals;
    } = {},
  ) {
    this.enabled = options.enabled ?? ((workspaceId) => artifactsEnabled(db, workspaceId));
    this.reads = new ArtifactReads(db, this.enabled);
    this.signals = options.signals;
  }

  /** The actor's access to a home: `NOT_FOUND` where it cannot read, as if nothing were there,
   * and `ACCESS_DENIED` where it reads but may not write. */
  private async requireHome(
    workspaceId: string,
    actor: ArtifactActor,
    homeKey: string,
    need: "read" | "write",
  ) {
    await requireArtifactHome(this.db, workspaceId, actor, homeKey, need);
  }

  /** A live artifact's home, author and entry, after the experiment check: what every access needs. */
  private async live(workspaceId: string, artifactId: string) {
    if (!(await this.enabled(workspaceId))) throw artifactsDisabled();
    const artifact = await this.db.artifact.findFirst({
      where: { id: artifactId, workspaceId, deletedAt: null },
      select: {
        homeKey: true,
        access: true,
        authorAgentId: true,
        entryPath: true,
      },
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
    entryPath: string;
    author: ArtifactPublisher;
    /** An idempotent create: the client's key, and a hash of this create's inputs. The same key
     * with the same hash returns the artifact already made; with a different hash it is a
     * conflict (task #385). */
    idempotencyKey?: string;
    requestHash?: string;
  }) {
    // The experiment first: a Workspace without it hears only that, whatever it sent.
    if (!(await this.enabled(input.workspaceId))) throw artifactsDisabled();
    // Anyone with the link is a home a later step adds, with its own switch and refusals.
    if (input.home.kind === "public") invalid("artifact-home");
    await this.requireHome(input.workspaceId, input.author, artifactHomeKey(input.home), "write");
    // The insert, name validation and idempotent replay live in artifact-create.server.ts.
    const { home, ...rest } = input;
    return createArtifact(this.db, { ...rest, homeKey: artifactHomeKey(home) });
  }

  async push(input: {
    workspaceId: string;
    artifactId: string;
    baseVersion: number;
    publisher: ArtifactPublisher;
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
  > {
    const live = await this.live(input.workspaceId, input.artifactId);
    const { homeKey } = live;
    if ((input.note?.length ?? 0) > ARTIFACT_NOTE_LIMIT) invalid("artifact-note");
    if ((input.label?.length ?? 0) > ARTIFACT_LABEL_LIMIT) invalid("artifact-label");
    await requireArtifactWrite(this.db, input.workspaceId, input.publisher, live, "write");
    const added = [...(input.files ?? [])];
    const deleted = [...new Set(input.deletedPaths ?? [])];
    // Every path is valid and named once: a file is added or deleted, not both, nor twice.
    const touched = [...added.map((file) => file.path), ...deleted];
    if (!touched.every(artifactPathValid) || new Set(touched).size !== touched.length)
      invalid("artifact-file-path");

    // The bytes are checked before the lock: a missing blob is a 200 the client uploads and retries.
    const named = [...new Set(added.map((file) => file.sha256))];
    const [blobs, allowed] = await Promise.all([
      this.blobs.inspectMany(input.workspaceId, named),
      this.blobs.allowed(input.workspaceId, input.artifactId, input.publisher, named),
    ]);
    // Bytes the publisher never uploaded, and this artifact does not use, are as good as missing.
    const missing = named.filter((sha256) => !blobs.has(sha256) || !allowed.has(sha256));
    if (missing.length) return { status: "missing", missing };
    for (const file of added) {
      const blob = blobs.get(file.sha256)!;
      const limit = blob.kind === "text" ? ARTIFACT_TEXT_LIMIT : ARTIFACT_BINARY_LIMIT;
      if (blob.sizeBytes > limit) invalid("artifact-file-too-large");
    }

    const saved = await this.db.$transaction(async (tx) => {
      // The comment lock before the row lock, the order a comment write takes them in; the check
      // below then sees every comment that committed, and none lands before this commits.
      await lockComments(tx, input.artifactId);
      // Serialize every push for this artifact: the base check, the replay check and the version
      // number are decided under one row lock, so a concurrent push cannot slip between them.
      const [locked] = await tx.$queryRaw<
        {
          id: string;
          currentVersion: number;
          entryPath: string;
          title: string;
          description: string;
        }[]
      >`SELECT "id", "currentVersion", "entryPath", "title", "description"
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
      await requireNoUnseenCommentsOnPush(tx, {
        artifactId: locked.id,
        agentId: input.publisher.agentId,
        touched,
        entry: { current: locked.entryPath, pushed: input.entryPath },
      });

      if (input.baseVersion > current || input.baseVersion < 0) refuseUnknownBase();

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

      // Deleting something the push's own base never held is a mistake, not a no-op.
      for (const path of deleted) if (!baseFiles.has(path)) invalid("artifact-file-path");

      // What others changed between the push's base and the current version; files merge by path,
      // and what both sides changed refuses the push.
      const othersChanged = new Set<string>();
      if (input.baseVersion < current) {
        for (const path of new Set([...baseFiles.keys(), ...currentFiles.keys()])) {
          const before = baseFiles.get(path);
          const now = currentFiles.get(path);
          if (before?.sha256 !== now?.sha256) othersChanged.add(path);
        }
        refuseOverlap({
          changed: othersChanged,
          current: currentFiles,
          added,
          deleted,
          settings: settings.conflicts,
        });
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
      const { entryPath } = settings.result;
      if (result.size && !result.has(entryPath)) invalid("artifact-entry-missing");
      if (entryPath !== locked.entryPath) requireOpenableEntry(entryPath);

      const merged = [...othersChanged].sort();
      const settingsChanged = ARTIFACT_SETTINGS.some(
        (name) => settings.result[name] !== currentSettings[name],
      );
      // A file sent again as it already is changes nothing.
      const filesChanged =
        deleted.length > 0 ||
        added.some((file) => currentFiles.get(file.path)?.sha256 !== result.get(file.path)!.sha256);
      // A label names the content as it is now, so it alone is a version worth saving.
      if (!filesChanged && !settingsChanged && !input.label)
        // Nothing of the pusher's own: "Nothing to push", even when others moved the artifact.
        return { status: "nothing" } as const;
      // In this transaction, so the sweep of unused blobs leaves them; one it removed since the
      // inspection above is uploaded again.
      const gone = await this.blobs.use(tx, input.workspaceId, [
        ...new Set(added.map((file) => result.get(file.path)!.sha256)),
      ]);
      if (gone.length) return { status: "missing", missing: gone } as const;

      const version = await writeVersion(tx, {
        artifactId: locked.id,
        number: current + 1,
        publisher: input.publisher,
        ...(input.note !== undefined && { note: input.note }),
        ...(input.label !== undefined && { label: input.label }),
        settings: settings.result,
        added,
        deleted,
        merged: { files: merged, settings: settings.merged },
        idempotencyKey: input.idempotencyKey,
        files: result.values(),
      });
      return {
        status: "created",
        versionId: version.id,
        number: version.number,
        merged,
        mergedSettings: settings.merged,
      } as const;
    });
    if (saved.status === "created")
      await announceVersion(this.signals, {
        workspaceId: input.workspaceId,
        homeKey,
        artifactId: input.artifactId,
        number: saved.number,
        publisher: input.publisher,
      });
    return saved;
  }

  /** Moves the artifact between read tiers (task #529): `conversation` keeps reads to its home
   * conversation's readers, `workspace` widens them to every Workspace member; writes never
   * follow the tier. The authoring Agent's owner, or a Workspace owner or admin may; an Agent
   * never may. */
  async changeAccess(input: {
    workspaceId: string;
    artifactId: string;
    actor: ArtifactActor;
    access: "conversation" | "workspace";
  }) {
    if (!(await this.enabled(input.workspaceId))) throw artifactsDisabled();
    await changeArtifactAccess(this.db, input.workspaceId, input.actor, input);
  }

  /** Soft-deletes the artifact (its name is free again at once); a Workspace owner or admin, among
   * those who can read it. An Agent deletes only its own. */
  async delete(input: { workspaceId: string; artifactId: string; actor: ArtifactActor }) {
    const artifact = await this.live(input.workspaceId, input.artifactId);
    await requireArtifactWrite(this.db, input.workspaceId, input.actor, artifact, "read");
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

  /** The artifact and one version (its current one by default) with that version's files. */
  read(input: Parameters<ArtifactReads["read"]>[0]) {
    return this.reads.read(input);
  }
}
