import type { PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import {
  canManageArtifactSharing,
  requireArtifactRead,
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
  name: string;
  title: string;
  currentVersion: number;
  authorAgentId: string | null;
};

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
      name: true,
      title: true,
      currentVersion: true,
      authorAgentId: true,
    },
  });
  if (!artifact) throw new AppError("NOT_FOUND");
  await requireArtifactRead(db, workspaceId, actor, artifact);
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
  if (actor.userId === undefined) return false;
  const { authorAgentId } = thread.artifact;
  const ownerId = authorAgentId
    ? (await db.agent.findFirst({ where: { id: authorAgentId }, select: { ownerId: true } }))
        ?.ownerId
    : undefined;
  return canManageArtifactSharing(db, workspaceId, actor, {
    ...thread.artifact,
    authorAgentOwnerId: ownerId ?? null,
  });
}
