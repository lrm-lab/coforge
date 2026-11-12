import type { PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import {
  artifactReadAccess,
  canChangeArtifactAccess,
  type ArtifactActor,
} from "./artifact-access.server";

type Db = Pick<PrismaClient, "artifact" | "workspaceMembership" | "agent" | "conversation">;

/** What a comment operation needs of the artifact it is about. `currentVersion` is as of the
 * lookup, for a read: a write takes the version it is on under the comment lock
 * (`currentVersionOf`). */
export type CommentedArtifact = {
  id: string;
  homeKey: string;
  access: string;
  currentVersion: number;
  authorAgentId: string | null;
};

/**
 * A live artifact the actor may read, or `NOT_FOUND`. Commenting needs read access and nothing
 * more: whoever can read an artifact (its home's readers, or every member of the Workspace when its
 * tier is `workspace`) may comment on it, with no write access to its home needed. A missing
 * artifact, another Workspace's, a deleted one and one the actor cannot read are all `NOT_FOUND`.
 */
export async function requireReadableArtifact(
  db: Db,
  workspaceId: string,
  actor: ArtifactActor,
  artifactId: string,
): Promise<CommentedArtifact> {
  const artifact = await db.artifact.findFirst({
    where: { id: artifactId, workspaceId, deletedAt: null },
    select: {
      id: true,
      homeKey: true,
      access: true,
      currentVersion: true,
      authorAgentId: true,
    },
  });
  if (!artifact || !(await artifactReadAccess(db, workspaceId, actor, artifact)))
    throw new AppError("NOT_FOUND");
  return artifact;
}

/**
 * Whether the actor resolves or reopens a thread: whoever started it (a person or an Agent), the
 * Agent that made the artifact, the owner of that Agent, and a Workspace owner or admin. The last
 * two are people.
 */
export async function canResolveArtifactComment(
  db: Pick<PrismaClient, "workspaceMembership" | "agent">,
  workspaceId: string,
  actor: ArtifactActor,
  thread: {
    artifact: { authorAgentId: string | null };
    root: { authorUserId: string | null; authorAgentId: string | null };
  },
): Promise<boolean> {
  const startedIt =
    actor.agentId !== undefined
      ? thread.root.authorAgentId === actor.agentId
      : thread.root.authorUserId === actor.userId;
  const madeIt = actor.agentId !== undefined && thread.artifact.authorAgentId === actor.agentId;
  if (startedIt || madeIt) return true;
  // The authoring Agent's owner and the admins: the access tier's rule.
  if (actor.userId === undefined) return false;
  const { authorAgentId } = thread.artifact;
  const ownerId = authorAgentId
    ? (await db.agent.findFirst({ where: { id: authorAgentId }, select: { ownerId: true } }))
        ?.ownerId
    : undefined;
  return canChangeArtifactAccess(db, workspaceId, actor, { authorAgentOwnerId: ownerId ?? null });
}
