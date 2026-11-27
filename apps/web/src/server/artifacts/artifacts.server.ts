import type { PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import { artifactOpenableKind } from "#src/features/artifacts/artifact-path-kind";
import {
  ARTIFACT_BINARY_LIMIT,
  ARTIFACT_ENTRY_READ_LIMIT,
  ARTIFACT_FILE_LIMIT,
  ARTIFACT_TEXT_LIMIT,
  artifactPathValid,
  type ArtifactBlobStore,
  type ArtifactFileInput,
  type ArtifactFileRow as FileRow,
} from "./artifact-files.server";
import {
  requireArtifactRead,
  requireConversationHome,
  artifactTier,
  canDeleteArtifact,
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
import { createVersionedArtifact } from "./artifact-create.server";
import { ArtifactReads } from "./artifact-reads.server";
import { recordingRefusal, requireNoUnseenChangesOnPush } from "./artifact-comment-gate.server";
import { requireNotSettledOrSeen, type ArtifactSettlementRow } from "./artifact-settlement.server";
import { lockComments } from "./artifact-comment-write.server";
import { settleWrite } from "./artifact-activity-wake.server";
import { announceVersion, type ArtifactSignals } from "./artifact-signals.server";
import { ArtifactVisibility } from "./artifact-visibility.server";
import {
  pinnedChannelPushBlock,
  type PinnedArtifactPushBlock,
} from "#src/server/conversations/channel-read-access.server";
import { writeVersion } from "./artifact-version-write.server";

export type ArtifactHome = { kind: "conversation"; conversationId: string } | { kind: "public" };

export type { ArtifactActor, ArtifactPublisher };
export * from "./artifact-files.server";

export const ARTIFACT_NOTE_LIMIT = 500;
export const ARTIFACT_LABEL_LIMIT = 60;

export function artifactHomeKey(home: ArtifactHome): string {
  return home.kind === "conversation" ? `conversation:${home.conversationId}` : home.kind;
}

function pinnedPushBlockHint(block: PinnedArtifactPushBlock): string {
  if (block.kind === "channel") {
    if (block.reason === "archived") {
      return `${block.channel} is archived, so its announcement cannot be changed. Unarchive ${block.channel} first, or push a copy as a new artifact into an active conversation.`;
    }
    return `Only a channel admin of ${block.channel} or a Workspace owner or admin can push updates to this artifact while it is pinned there.`;
  }
  if (block.reason === "archived") {
    return `${block.target} is archived, so its pinned content cannot be changed. Push a copy as a new artifact into an active conversation.`;
  }
  if (block.reason === "peer_not_member") {
    return `The other participant in ${block.target} is no longer an active member of this Workspace, so its pinned content cannot be changed. Push a copy as a new artifact into an active conversation.`;
  }
  return `You cannot send messages in ${block.target}, so its pinned content cannot be changed. Push a copy as a new artifact into a conversation you can post in.`;
}

function invalid(errorId: string): never {
  throw new AppError("INVALID_INPUT", { errorId });
}

export class Artifacts {
  readonly reads: ArtifactReads;
  readonly visibility: ArtifactVisibility;
  private readonly signals?: ArtifactSignals;

  constructor(
    private readonly db: PrismaClient,
    private readonly blobs: ArtifactBlobStore,
    options: {
      signals?: ArtifactSignals;
    } = {},
  ) {
    this.reads = new ArtifactReads(db);
    this.signals = options.signals;
    this.visibility = new ArtifactVisibility(db, options.signals);
  }

  private async live(workspaceId: string, artifactId: string) {
    const artifact = await this.db.artifact.findFirst({
      where: { id: artifactId, workspaceId, deletedAt: null },
      select: {
        id: true,
        name: true,
        title: true,
        currentVersion: true,
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
    author: ArtifactActor;
    idempotencyKey?: string;
    requestHash?: string;
    origin?: { messageId: string; attachmentId: string };
    version?: { files: readonly ArtifactFileInput[]; idempotencyKey: string };
    beforeAnnounce?: (artifactId: string) => Promise<unknown>;
  }) {
    if (input.home.kind === "public") invalid("artifact-home");
    const homeKey = artifactHomeKey(input.home);
    await requireConversationHome(
      this.db,
      input.workspaceId,
      input.author,
      input.home.conversationId,
      "write",
    );
    const { home: _home, ...rest } = input;
    const saved = await createVersionedArtifact(this.db, this.blobs, { ...rest, homeKey });
    if (saved.fresh && input.version !== undefined) {
      await input.beforeAnnounce?.(saved.artifact.id);
      await announceVersion(this.signals, {
        workspaceId: input.workspaceId,
        homeKey,
        wide: false,
        artifactId: saved.artifact.id,
        number: 1,
      });
    }
    return saved.artifact;
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
    beforeAnnounce?: (saved: { number: number; cardStale: boolean }) => Promise<unknown>;
  }): Promise<
    | {
        status: "created";
        versionId: string;
        number: number;
        merged: string[];
        mergedSettings: ArtifactSettingName[];
        cardStale: boolean;
      }
    | { status: "replayed"; versionId: string; number: number }
    | { status: "nothing"; titleChanged?: { from: string } }
    | { status: "missing"; missing: string[] }
  > {
    const live = await this.live(input.workspaceId, input.artifactId);
    const { homeKey } = live;
    if ((input.note?.length ?? 0) > ARTIFACT_NOTE_LIMIT) invalid("artifact-note");
    if ((input.label?.length ?? 0) > ARTIFACT_LABEL_LIMIT) invalid("artifact-label");
    const [readError, pinBlock] = await Promise.all([
      requireArtifactRead(this.db, input.workspaceId, input.publisher, live).then(
        () => null,
        (error: unknown) => error,
      ),
      pinnedChannelPushBlock(this.db, input.workspaceId, input.artifactId, input.publisher),
    ]);
    if (readError) throw readError;
    if (pinBlock) {
      throw new AppError("ACCESS_DENIED", {
        errorId: "channel-announcement-push-forbidden",
        details: {
          channel: pinBlock.kind === "channel" ? pinBlock.channel : pinBlock.target,
          reason: pinBlock.reason,
        },
        hint: pinnedPushBlockHint(pinBlock),
      });
    }
    const added = [...(input.files ?? [])];
    const deleted = [...new Set(input.deletedPaths ?? [])];
    const touched = [...added.map((file) => file.path), ...deleted];
    if (!touched.every(artifactPathValid) || new Set(touched).size !== touched.length)
      invalid("artifact-file-path");

    const named = [...new Set(added.map((file) => file.sha256))];
    const [blobs, allowed] = await Promise.all([
      this.blobs.inspectMany(input.workspaceId, named),
      this.blobs.allowed(input.workspaceId, input.artifactId, input.publisher, named),
    ]);
    const missing = named.filter((sha256) => !blobs.has(sha256) || !allowed.has(sha256));
    if (missing.length) return { status: "missing", missing };
    for (const file of added) {
      const blob = blobs.get(file.sha256)!;
      const limit = blob.kind === "text" ? ARTIFACT_TEXT_LIMIT : ARTIFACT_BINARY_LIMIT;
      if (blob.sizeBytes > limit) invalid("artifact-file-too-large");
    }

    const saved = await recordingRefusal(
      this.db,
      { artifactId: input.artifactId, agentId: input.publisher.agentId },
      () =>
        this.db.$transaction(async (tx) => {
          await lockComments(tx, input.artifactId);
          const [locked] = await tx.$queryRaw<
            ({
              id: string;
              currentVersion: number;
              entryPath: string;
              title: string;
              description: string;
            } & ArtifactSettlementRow)[]
          >`SELECT "id", "currentVersion", "entryPath", "title", "description",
                   "settledAt", "settledVersion", "settledByKind", "settledById", "reopenedAtVersion"
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
          await requireNoUnseenChangesOnPush(tx, {
            workspaceId: input.workspaceId,
            artifactId: locked.id,
            agentId: input.publisher.agentId,
            touched,
            entry: { current: locked.entryPath, pushed: input.entryPath },
          });

          if (input.baseVersion > current || input.baseVersion < 0) refuseUnknownBase();

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

          for (const path of deleted) if (!baseFiles.has(path)) invalid("artifact-file-path");

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
          const entry = result.get(entryPath);
          if (
            entry !== undefined &&
            artifactOpenableKind(entryPath) !== null &&
            entry.sizeBytes > ARTIFACT_ENTRY_READ_LIMIT
          )
            invalid("artifact-entry-too-large");

          const merged = [...othersChanged].sort();
          const settingsChanged = ARTIFACT_SETTINGS.some(
            (name) => settings.result[name] !== currentSettings[name],
          );
          const cardStale =
            settings.result.entryPath !== currentSettings.entryPath ||
            (artifactOpenableKind(settings.result.entryPath) === "html"
              ? settings.result.description !== currentSettings.description
              : result.get(settings.result.entryPath)?.sha256 !==
                currentFiles.get(currentSettings.entryPath)?.sha256);
          const filesChanged =
            deleted.length > 0 ||
            added.some(
              (file) => currentFiles.get(file.path)?.sha256 !== result.get(file.path)!.sha256,
            );
          const onlyRenamed =
            !filesChanged &&
            !input.label &&
            !input.note &&
            settings.result.title !== currentSettings.title &&
            settings.result.description === currentSettings.description &&
            settings.result.entryPath === currentSettings.entryPath;
          if (onlyRenamed) {
            await tx.artifact.update({
              where: { id: locked.id },
              data: { title: settings.result.title },
            });
            await tx.artifactVersion.updateMany({
              where: { artifactId: locked.id, number: current },
              data: { title: settings.result.title },
            });
            return { status: "nothing", titleChanged: { from: currentSettings.title } } as const;
          }
          if (!filesChanged && !settingsChanged && !input.label)
            return { status: "nothing" } as const;
          await requireNotSettledOrSeen(tx, {
            workspaceId: input.workspaceId,
            artifactId: locked.id,
            agentId: input.publisher.agentId,
            current,
            title: locked.title,
            settlement: locked,
          });
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
          if (locked.settledAt !== null && locked.reopenedAtVersion === null) {
            await tx.artifact.update({
              where: { id: locked.id },
              data: { reopenedAtVersion: current + 1 },
            });
          }
          return {
            status: "created",
            versionId: version.id,
            number: version.number,
            merged,
            mergedSettings: settings.merged,
            cardStale,
          } as const;
        }),
    );
    if (saved.status === "created") {
      await input.beforeAnnounce?.(saved);
      await announceVersion(this.signals, {
        workspaceId: input.workspaceId,
        homeKey,
        wide: artifactTier(live) === "workspace",
        artifactId: input.artifactId,
        number: saved.number,
      });
      settleWrite(this.db, this.signals, {
        workspaceId: input.workspaceId,
        artifact: live,
        writerUserId: input.publisher.userId,
      });
    }
    return saved;
  }

  async delete(input: { workspaceId: string; artifactId: string; actor: ArtifactActor }) {
    const artifact = await this.live(input.workspaceId, input.artifactId);
    await requireArtifactRead(this.db, input.workspaceId, input.actor, artifact);
    if (!(await canDeleteArtifact(this.db, input.workspaceId, input.actor, artifact)))
      throw new AppError("ACCESS_DENIED", {
        errorId: "artifact-delete-forbidden",
        ...(input.actor.agentId
          ? { hint: "only the Agent that made an artifact can delete it" }
          : {}),
      });
    await this.db.artifact.updateMany({
      where: { id: input.artifactId, workspaceId: input.workspaceId, deletedAt: null },
      data: {
        deletedAt: new Date(),
        ...(input.actor.agentId
          ? { deletedByAgentId: input.actor.agentId }
          : { deletedByUserId: input.actor.userId }),
      },
    });
    return {
      id: artifact.id,
      name: artifact.name,
      title: artifact.title,
      currentVersion: artifact.currentVersion,
    };
  }
}
