import { createHash } from "node:crypto";
import type { PrismaClient } from "#src/generated/prisma/client";
import { AppError, isAppError } from "#src/lib/app-error";
import { nameToSlug } from "#src/lib/slug";
import { errorType } from "#src/server/errors/error-type.server";
import {
  canDeleteArtifact,
  requireArtifactHome,
  type ArtifactActor,
} from "./artifact-access.server";
import type { StoredArtifactBlobs } from "./artifact-blobs.server";
import { ARTIFACT_DOCUMENT_LIMIT } from "./artifact-files.server";
import type { ArtifactRevert } from "./artifact-revert.server";
import type { Artifacts } from "./artifacts.server";

/** A document's one file. */
export const DOCUMENT_PATH = "document.md";
/** Names tried in sequence for a document whose title's name is taken in its home (`plan`,
 * `plan-2`, `plan-3`), before a short random suffix, which a title of no Latin letters or digits
 * (named `document`) reaches soon. */
const SEQUENTIAL_NAMES = 3;
const NAME_TRIES = 8;

/** Who acts, and in which Workspace. */
export type DocumentScope = { workspaceId: string; actor: ArtifactActor };

/**
 * Documents as the web page uses them (task #385): a `markdown` artifact with one file,
 * `document.md`, whose text the page sends and receives — it never handles blobs. Every
 * operation is the artifact service's, with its experiment check, access rules and merge.
 */
export class ArtifactDocuments {
  constructor(
    private readonly db: PrismaClient,
    private readonly artifacts: Artifacts,
    private readonly blobs: Pick<StoredArtifactBlobs, "upload" | "read">,
  ) {}

  /** A new document in a conversation, or the Workspace when none is named; named from its
   * title, with `text` (when given) as version 1. An `idempotencyKey` makes the create safe to
   * retry: the same key with the same title, home and text returns the document already made,
   * and a different one is a conflict. */
  async create(
    scope: DocumentScope,
    input: { conversationId?: string; title: string; text?: string; idempotencyKey?: string },
  ) {
    const title = input.title.trim();
    if (!title || title.length > 200)
      throw new AppError("INVALID_INPUT", { errorId: "artifact-title" });
    // Checked before anything is made, so a refused text leaves no empty document behind.
    if (input.text !== undefined) documentBytes(input.text);
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
            text: input.text,
          });
    const base = nameToSlug(title, 56) || "document";
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
          kind: "markdown",
          entryPath: DOCUMENT_PATH,
          author: scope.actor,
          ...(input.idempotencyKey !== undefined
            ? { idempotencyKey: input.idempotencyKey, requestHash }
            : {}),
        });
        if (input.text !== undefined)
          await this.save(scope, {
            artifactId: created.id,
            baseVersion: 0,
            text: input.text,
            // On a replayed create this save replays too (same key on the same artifact), so a
            // retry adds no second version; a fresh create gets its version 1.
            idempotencyKey:
              input.idempotencyKey === undefined
                ? crypto.randomUUID()
                : `${input.idempotencyKey}:v1`,
          });
        return (
          await this.artifacts.reads.cards({ ...reader(scope), artifactIds: [created.id] })
        )[0]!;
      } catch (error) {
        const taken = isAppError(error) && error.errorId === "artifact-name-taken";
        if (!taken || attempt >= NAME_TRIES) throw error;
      }
    }
  }

  /** The document at a version (its current one by default), with its text and whether the actor
   * may delete it; a non-document artifact has no text here. */
  async load(scope: DocumentScope, input: { artifactId: string; version?: number }) {
    const read = await this.artifacts.read({ ...reader(scope), ...input });
    const file = read.files.find((entry) => entry.path === read.artifact.entryPath);
    const document =
      read.artifact.kind === "markdown" &&
      file?.kind === "text" &&
      file.sizeBytes <= ARTIFACT_DOCUMENT_LIMIT;
    const bytes = document ? await this.blobs.read(scope.workspaceId, file.sha256) : null;
    // The author came with the read (no second query); the rule is the one `delete` enforces.
    const canDelete = await canDeleteArtifact(
      this.db,
      scope.workspaceId,
      scope.actor,
      read.artifact,
    );
    return {
      ...read,
      text: bytes ? new TextDecoder().decode(bytes) : "",
      canDelete,
      homeKind: read.artifact.homeKind,
    };
  }

  /**
   * Saves the document's text (and settings) over `baseVersion`. The actor's access is checked
   * first, then the text is stored as its bytes and saved as any artifact save is: merged with
   * what others saved meanwhile, or answered with a conflict that wrote nothing.
   */
  async save(
    scope: DocumentScope,
    input: {
      artifactId: string;
      baseVersion: number;
      idempotencyKey: string;
      text?: string;
      title?: string;
      description?: string;
      note?: string;
      label?: string;
    },
  ) {
    const { text, ...settings } = input;
    let files: { path: string; sha256: string }[] = [];
    if (text !== undefined) {
      const bytes = documentBytes(text);
      // Nothing is stored for someone who may not save here, or where documents are off.
      const artifact = await this.artifacts.reads.artifact(
        scope.workspaceId,
        input.artifactId,
        scope.actor,
      );
      await requireArtifactHome(this.db, scope.workspaceId, scope.actor, artifact.homeKey, "write");
      if (artifact.kind !== "markdown")
        throw new AppError("INVALID_INPUT", { errorId: "artifact-kind" });
      const blob = await this.blobs.upload({
        workspaceId: scope.workspaceId,
        bytes,
        actor: scope.actor,
      });
      // The document's own file, which `load` reads: `document.md` for one the page made.
      files = [{ path: artifact.entryPath, sha256: blob.sha256 }];
    }
    const saved = await this.artifacts.push({
      workspaceId: scope.workspaceId,
      publisher: scope.actor,
      files,
      ...settings,
    });
    if (saved.status === "created") await this.#refreshPreview(scope, input.artifactId);
    return saved;
  }

  /** Goes back to a version, and keeps the card's preview from it. */
  async revert(input: ArtifactRevert) {
    const saved = await this.artifacts.revert(input);
    if (saved.status === "created") await this.#refreshPreview(input, input.artifactId);
    return saved;
  }

  /** The documents of a conversation (or the Workspace) the actor may read, newest first. */
  list(scope: DocumentScope, input: { conversationId?: string }) {
    return this.artifacts.reads.list({ ...reader(scope), ...input });
  }

  /** Cards of the named documents the actor may read; any other is left out. */
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
 * title, home or text is caught as a conflict rather than silently returning the first document.
 * A missing text is distinct from an empty one. */
function createRequestHash(input: { homeKey: string; title: string; text?: string }): string {
  const parts = JSON.stringify([input.homeKey, input.title, input.text ?? null]);
  return createHash("sha256").update(parts).digest("hex");
}

/** A document's text as the bytes stored: at most 2 MiB, and text (no NUL), so it reads back as
 * the same text. */
function documentBytes(text: string) {
  if (text.includes("\u0000")) throw new AppError("INVALID_INPUT", { errorId: "artifact-text" });
  const bytes = new TextEncoder().encode(text) as Uint8Array<ArrayBuffer>;
  if (bytes.length > ARTIFACT_DOCUMENT_LIMIT)
    throw new AppError("INVALID_INPUT", { errorId: "artifact-file-too-large" });
  return bytes;
}

const reader = (scope: DocumentScope) => ({ workspaceId: scope.workspaceId, reader: scope.actor });

/**
 * A document's card line: its first two lines with text, without the Markdown marks that open
 * them (headings, quotes, list bullets), each at most 200 characters.
 */
export function artifactPreview(text: string): string {
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
 * Keeps a document's preview from its current version: read after a save, written only while
 * that version is still the current one, best effort (a card shows the previous preview until
 * the next save).
 */
export async function refreshPreview(
  db: PrismaClient,
  blobs: Pick<StoredArtifactBlobs, "read">,
  workspaceId: string,
  artifactId: string,
) {
  const artifact = await db.artifact.findFirst({
    where: { id: artifactId, workspaceId, kind: "markdown", deletedAt: null },
    select: { currentVersion: true, entryPath: true },
  });
  if (!artifact || artifact.currentVersion <= 0) return;
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
    file && file.sizeBytes <= ARTIFACT_DOCUMENT_LIMIT
      ? await blobs.read(workspaceId, file.sha256)
      : null;
  await db.artifact.updateMany({
    where: { id: artifactId, currentVersion: artifact.currentVersion },
    data: { preview: bytes ? artifactPreview(new TextDecoder().decode(bytes)) : "" },
  });
}
