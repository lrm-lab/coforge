import { createHash } from "node:crypto";
import type { PrismaClient } from "#src/generated/prisma/client";
import { AppError, isAppError } from "#src/lib/app-error";
import { nameToSlug } from "#src/lib/slug";
import { errorType } from "#src/server/errors/error-type.server";
import {
  canDeleteArtifact,
  type ArtifactActor,
  type ArtifactPublisher,
} from "./artifact-access.server";
import type { StoredArtifactBlobs } from "./artifact-blobs.server";
import { ARTIFACT_ENTRY_READ_LIMIT, artifactKindOfPath } from "./artifact-files.server";
import { planManifestCreate, type FileManifest } from "./artifact-manifest.server";
import type { Artifacts } from "./artifacts.server";

/** The name a title of no Latin letters or digits falls back to. */
const FALLBACK_NAME = "artifact";
/** Names tried in sequence for an artifact whose title's name is taken in its home (`plan`,
 * `plan-2`, `plan-3`), before a short random suffix, which a title of no Latin letters or digits
 * (named `artifact`) reaches soon. */
const SEQUENTIAL_NAMES = 3;
const NAME_TRIES = 8;

/** Who reads, and in which Workspace. */
export type DocumentScope = { workspaceId: string; actor: ArtifactActor };

/** Who writes, and in which Workspace: an Agent. */
export type WriteScope = { workspaceId: string; actor: ArtifactPublisher };

/**
 * The artifact use cases the Agent API and the web page share (task #385): an Agent writes an
 * artifact as a manifest of files (`create` for a new one, `push` over a version), and either
 * reads one back — the web page shows the entry file's text and never handles blobs. Every
 * operation is the artifact service's, with its experiment check, access rules and merge.
 */
export class ArtifactDocuments {
  constructor(
    private readonly db: PrismaClient,
    private readonly artifacts: Artifacts,
    private readonly blobs: Pick<StoredArtifactBlobs, "read" | "inspectMany" | "allowed">,
  ) {}

  /** A new artifact in a conversation, or the Workspace when none is named; named from its title,
   * with the `manifest`'s files as version 1. An `idempotencyKey` makes the create safe to retry:
   * the same key with the same home, title, description and files returns the one already made,
   * and a different one is a conflict. The manifest's entry file gives its type
   * (`planManifestCreate`). */
  async create(
    scope: WriteScope,
    input: {
      conversationId?: string;
      title: string;
      description?: string;
      manifest: FileManifest;
      idempotencyKey?: string;
    },
  ) {
    const plan = planManifestCreate(input.manifest);
    const title = input.title.trim();
    if (!title || title.length > 200)
      throw new AppError("INVALID_INPUT", { errorId: "artifact-title" });
    const description = input.description?.trim() ?? "";
    const home = input.conversationId
      ? ({ kind: "conversation", conversationId: input.conversationId } as const)
      : ({ kind: "workspace" } as const);
    // The create's inputs, hashed, so a retry with the same key but different inputs is caught.
    const requestHash =
      input.idempotencyKey === undefined
        ? undefined
        : createRequestHash({
            homeKey: input.conversationId ? `conversation:${input.conversationId}` : "workspace",
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
      try {
        const created = await this.artifacts.create({
          workspaceId: scope.workspaceId,
          home,
          name,
          title,
          ...(description ? { description } : {}),
          entryPath: plan.entryPath,
          author: scope.actor,
          ...(input.idempotencyKey !== undefined
            ? { idempotencyKey: input.idempotencyKey, requestHash }
            : {}),
        });
        const first = await this.push(scope, {
          artifactId: created.id,
          baseVersion: 0,
          manifest: { files: plan.files },
          // On a replayed create this push replays too (same key on the same artifact), so a
          // retry adds no second version; a fresh create gets its version 1.
          idempotencyKey:
            input.idempotencyKey === undefined ? crypto.randomUUID() : `${input.idempotencyKey}:v1`,
        });
        // Bytes that vanished since `missingBytes` looked: the same request, sent again after
        // uploading them, replays this create (with its key) and saves them.
        if (first.status === "missing")
          throw new AppError("TEMPORARILY_UNAVAILABLE", { errorId: "artifact-bytes-missing" });
        return (
          await this.artifacts.reads.cards({ ...reader(scope), artifactIds: [created.id] })
        )[0]!;
      } catch (error) {
        const taken = isAppError(error) && error.errorId === "artifact-name-taken";
        if (!taken || attempt >= NAME_TRIES) throw error;
      }
    }
  }

  /** The sha256s of a manifest create's files the Agent has not uploaded: asked before the
   * artifact is made, so a create the client must retry after uploading leaves nothing behind.
   * A manifest that would not make an artifact is refused here as `create` refuses it. */
  async missingBytes(scope: WriteScope, input: { manifest: FileManifest }): Promise<string[]> {
    const { files } = planManifestCreate(input.manifest);
    const named = [...new Set(files.map((file) => file.sha256))];
    // No artifact exists yet, so only bytes the Agent uploaded count as its own.
    const [stored, granted] = await Promise.all([
      this.blobs.inspectMany(scope.workspaceId, named),
      this.blobs.allowed(scope.workspaceId, undefined, scope.actor, named),
    ]);
    return named.filter((sha256) => !stored.has(sha256) || !granted.has(sha256));
  }

  /** The artifact at a version (its current one by default), with its entry file's text and
   * whether the actor may delete it; an entry file too large to read whole has no text here. */
  async load(scope: DocumentScope, input: { artifactId: string; version?: number }) {
    const read = await this.artifacts.read({ ...reader(scope), ...input });
    const file = read.files.find((entry) => entry.path === read.artifact.entryPath);
    const readable = file?.kind === "text" && file.sizeBytes <= ARTIFACT_ENTRY_READ_LIMIT;
    const bytes = readable ? await this.blobs.read(scope.workspaceId, file.sha256) : null;
    // The author came with the read (no second query); the rule is the one `delete` enforces —
    // and a reader the widened tier let in cannot delete at all: a delete is the home's write
    // (task #529).
    const canDelete =
      read.artifact.homeRead &&
      (await canDeleteArtifact(this.db, scope.workspaceId, scope.actor, read.artifact));
    return {
      ...read,
      text: bytes ? new TextDecoder().decode(bytes) : "",
      canDelete,
      homeKind: read.artifact.homeKind,
    };
  }

  /**
   * Pushes a version over `baseVersion`: the manifest's files and the settings, saved as any
   * artifact save is — merged by path with what others saved meanwhile, or refused when both
   * changed the same file or setting (`artifact-base-moved`), and nothing written.
   */
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
  ) {
    const { manifest, ...settings } = input;
    const saved = await this.artifacts.push({
      workspaceId: scope.workspaceId,
      publisher: scope.actor,
      ...(manifest?.files && { files: manifest.files }),
      ...(manifest?.deletedPaths && { deletedPaths: manifest.deletedPaths }),
      ...(manifest?.entryPath !== undefined && { entryPath: manifest.entryPath }),
      ...settings,
    });
    if (saved.status === "created") await this.#refreshPreview(scope, input.artifactId);
    return saved;
  }

  /** The artifacts of a conversation (or the Workspace) the actor may read, newest first. */
  list(scope: DocumentScope, input: { conversationId?: string }) {
    return this.artifacts.reads.list({ ...reader(scope), ...input });
  }

  /** A page of the same list, filtered by title words (`ArtifactReads.listPage`). */
  listPage(
    scope: DocumentScope,
    input: { conversationId?: string; query?: string; cursor?: string; limit: number },
  ) {
    return this.artifacts.reads.listPage({ ...reader(scope), ...input });
  }

  /** Cards of the named artifacts the actor may read; any other is left out. */
  cards(scope: DocumentScope, artifactIds: readonly string[]) {
    return this.artifacts.reads.cards({ ...reader(scope), artifactIds });
  }

  /** The preview after a save that committed: a failure is logged, never the save's. */
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

/** A stable hash of a create's inputs, so a retry with the same idempotency key but a different
 * title, home or files is caught as a conflict rather than silently returning the first artifact. */
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

/**
 * A Markdown file's card line: its first two lines with text, without the Markdown marks that open
 * them (headings, quotes, list bullets), each at most 200 characters.
 */
function artifactPreview(text: string): string {
  return text
    .split("\n")
    .map((line) =>
      line
        .replace(/^\s*(?:#{1,6}\s+|>\s?|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/, "")
        .trim()
        .slice(0, 200),
    )
    .filter((line) => line !== "")
    .slice(0, 2)
    .join("\n");
}

/**
 * Keeps an artifact's preview from its current version: a Markdown entry's first lines, and a web
 * page's description. Read after a save, written only while that version is still the current
 * one, best effort (a card shows the previous preview until the next save).
 */
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
  const kind = artifactKindOfPath(artifact.entryPath);
  // A web page's card line is its description (task #490): its source reads as nothing.
  if (kind === "html") {
    await db.artifact.updateMany({
      where: { id: artifactId, currentVersion: artifact.currentVersion },
      data: { preview: artifactPreview(artifact.description) },
    });
    return;
  }
  if (kind !== "markdown") return;
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
