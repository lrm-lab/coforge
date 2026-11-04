import type { Artifact, PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import type { ArtifactActor } from "./artifact-access.server";

/**
 * Creating an artifact (task #385): the one insert, with idempotent-create replay on top. A
 * create that carries a key the Workspace already used returns the artifact it made (replay)
 * when the inputs match, and is a conflict when they differ, so a lost response on the first
 * try does not leave a second document behind. The caller has already checked the experiment,
 * the name, the kind and the home.
 */

const NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const KINDS = new Set(["html", "markdown", "text", "csv", "image", "pdf", "video", "other"]);

export type CreateArtifactInput = {
  workspaceId: string;
  homeKey: string;
  name: string;
  title?: string;
  description?: string;
  kind: string;
  entryPath: string;
  author: ArtifactActor;
  /** An idempotent create: the client's key, and a hash of this create's inputs. The same key
   * with the same hash returns the artifact already made; with a different hash it is a
   * conflict. */
  idempotencyKey?: string;
  requestHash?: string;
};

/** Validates the name, kind and description, then inserts the artifact — or replays the one this
 * key already made. */
export async function createArtifact(
  db: PrismaClient,
  input: CreateArtifactInput,
): Promise<Artifact> {
  if (!NAME.test(input.name)) invalid("artifact-name");
  if (!KINDS.has(input.kind)) invalid("artifact-kind");
  if (input.description && input.description.length > 1000) invalid("artifact-description");
  // A create that already ran under this key returns its artifact again (replay), unless its
  // inputs differ, which is a mistake, not a retry.
  if (input.idempotencyKey !== undefined) {
    const replay = await createReplay(
      db,
      input.workspaceId,
      input.idempotencyKey,
      input.requestHash,
    );
    if (replay) return replay;
  }
  try {
    return await db.artifact.create({
      data: {
        workspaceId: input.workspaceId,
        homeKey: input.homeKey,
        // A workspace-home artifact's only tier is `workspace` (task #529).
        access: input.homeKey === "workspace" ? "workspace" : "conversation",
        name: input.name,
        title: input.title ?? "",
        description: input.description ?? "",
        kind: input.kind,
        entryPath: input.entryPath,
        ...actorColumns(input.author),
        ...(input.idempotencyKey !== undefined
          ? { idempotencyKey: input.idempotencyKey, requestHash: input.requestHash ?? null }
          : {}),
      },
    });
  } catch (error) {
    // Two racing creates with one key: the loser reads the winner's row and replays it.
    if (isUniqueViolation(error, "artifacts_idempotency_key") && input.idempotencyKey) {
      const replay = await createReplay(
        db,
        input.workspaceId,
        input.idempotencyKey,
        input.requestHash,
      );
      if (replay) return replay;
    }
    // The live-name unique index is the authority: a soft-deleted row releases the name.
    if (isUniqueViolation(error))
      throw new AppError("CONFLICT", { errorId: "artifact-name-taken" });
    throw error;
  }
}

/** The live artifact a create's key already made, when its inputs match (replay); a different
 * `requestHash` is a conflict. Null when the key has made nothing. */
async function createReplay(
  db: PrismaClient,
  workspaceId: string,
  idempotencyKey: string,
  requestHash?: string,
): Promise<Artifact | null> {
  const existing = await db.artifact.findFirst({
    where: { workspaceId, idempotencyKey, deletedAt: null },
  });
  if (!existing) return null;
  if ((existing.requestHash ?? null) !== (requestHash ?? null))
    throw new AppError("CONFLICT", { errorId: "artifact-idempotency-mismatch" });
  return existing;
}

/** The author columns for an actor: a person's or an Agent's, never both. */
export function actorColumns(actor: ArtifactActor) {
  return actor.agentId
    ? { authorAgentId: actor.agentId, authorUserId: null }
    : { authorUserId: actor.userId, authorAgentId: null };
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
