import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import {
  actorConversationHomeReads,
  actorsWithoutConversationRead,
} from "#src/server/conversations/channel-read-access.server";
import {
  artifactAuthorOwnerId,
  artifactHomeConversationId,
  artifactReadView,
  artifactTier,
  artifactViewer,
  artifactsDisabled,
  canManageArtifactSharing,
  canManageArtifactSharingWithRole,
  homeStands,
  requireArtifactRead,
  type ArtifactActor,
  type ArtifactTier,
} from "./artifact-access.server";
import { announceAccessChange, type ArtifactSignals } from "./artifact-signals.server";

type LockedArtifact = {
  id: string;
  name: string;
  title: string;
  currentVersion: number;
  homeKey: string;
  access: string;
  authorAgentId: string | null;
};

const summaryOf = ({ id, name, title, currentVersion }: LockedArtifact) => ({
  id,
  name,
  title,
  currentVersion,
});

const homeGone = () =>
  new AppError("CONFLICT", {
    errorId: "artifact-home-gone",
    hint: "its conversation no longer exists or is hidden, so it cannot be narrowed back to it",
  });

const moveRefusal = (reason: "no-owner" | "owner-cannot-see" | "owner-cannot-move") =>
  new AppError("ACCESS_DENIED", {
    errorId: "artifact-move-forbidden",
    details: { reason },
    hint: {
      "no-owner": "the Agent's owner is no longer a member of this Workspace",
      "owner-cannot-see": "the Agent's owner cannot see this artifact",
      "owner-cannot-move": "the Agent's owner may not widen who can see this artifact",
    }[reason],
  });

export class ArtifactVisibility {
  constructor(
    private readonly db: PrismaClient,
    private readonly enabled: (workspaceId: string) => Promise<boolean>,
    private readonly signals?: ArtifactSignals,
  ) {}

  async change(input: {
    workspaceId: string;
    artifactId: string;
    userId: string;
    tier: ArtifactTier;
  }) {
    if (!(await this.enabled(input.workspaceId))) throw artifactsDisabled();
    const actor = { userId: input.userId };
    const changed = await this.db.$transaction(async (tx) => {
      const artifact = await lockArtifact(tx, input);
      const authorAgentOwnerId = await artifactAuthorOwnerId(tx, artifact.authorAgentId);
      await requireArtifactRead(tx, input.workspaceId, actor, artifact, { authorAgentOwnerId });
      if (!(await canManageArtifactSharing(tx, input.workspaceId, actor, { authorAgentOwnerId })))
        throw new AppError("ACCESS_DENIED");
      const from = artifactTier(artifact);
      if (from === input.tier) return { artifact, from, changed: false };
      if (input.tier === "conversation")
        await requireNarrowableHome(tx, input.workspaceId, actor, artifact);
      await writeTier(tx, artifact, from, input.tier, actor);
      return { artifact, from, changed: true };
    });
    if (changed.changed)
      await announceAccessChange(this.signals, {
        workspaceId: input.workspaceId,
        homeKey: changed.artifact.homeKey,
        artifactId: changed.artifact.id,
        tier: input.tier,
      });
    return { artifact: summaryOf(changed.artifact), from: changed.from, to: input.tier };
  }

  async loss(input: { workspaceId: string; artifactId: string; userId: string }) {
    if (!(await this.enabled(input.workspaceId))) throw artifactsDisabled();
    const actor = { userId: input.userId };
    const artifact = await readArtifact(this.db, input);
    const authorAgentOwnerId = await artifactAuthorOwnerId(this.db, artifact.authorAgentId);
    await requireArtifactRead(this.db, input.workspaceId, actor, artifact, { authorAgentOwnerId });
    if (
      !(await canManageArtifactSharing(this.db, input.workspaceId, actor, { authorAgentOwnerId }))
    )
      throw new AppError("ACCESS_DENIED");
    const conversationId = await requireNarrowableHome(this.db, input.workspaceId, actor, artifact);
    const counts = await actorsWithoutConversationRead(this.db, input.workspaceId, conversationId);
    if (!counts) throw homeGone();
    return counts;
  }

  async moveToWorkspace(input: { workspaceId: string; artifactId: string; agentId: string }) {
    if (!(await this.enabled(input.workspaceId))) throw artifactsDisabled();
    const actor = { agentId: input.agentId };
    const moved = await this.db.$transaction(async (tx) => {
      const artifact = await lockArtifact(tx, input);
      await requireArtifactRead(tx, input.workspaceId, actor, artifact);
      if (artifact.authorAgentId !== input.agentId)
        throw new AppError("ACCESS_DENIED", {
          errorId: "artifact-move-not-author",
          hint: "only the Agent that made an artifact can move it",
        });
      if (artifactTier(artifact) === "workspace")
        throw new AppError("CONFLICT", {
          errorId: "artifact-home-not-wider",
          hint: "everyone in the Workspace can already see it",
        });
      await requireOwnerMayWiden(tx, input.workspaceId, artifact);
      await writeTier(tx, artifact, "conversation", "workspace", actor);
      return artifact;
    });
    await announceAccessChange(this.signals, {
      workspaceId: input.workspaceId,
      homeKey: moved.homeKey,
      artifactId: moved.id,
      tier: "workspace",
    });
    return { artifact: summaryOf(moved), from: "conversation", to: "workspace" } as const;
  }
}

type Tx = Prisma.TransactionClient | PrismaClient;

async function readArtifact(
  db: Tx,
  input: { workspaceId: string; artifactId: string },
): Promise<LockedArtifact> {
  const artifact = await db.artifact.findFirst({
    where: { id: input.artifactId, workspaceId: input.workspaceId, deletedAt: null },
    select: {
      id: true,
      name: true,
      title: true,
      currentVersion: true,
      homeKey: true,
      access: true,
      authorAgentId: true,
    },
  });
  if (!artifact) throw new AppError("NOT_FOUND");
  return artifact;
}

async function lockArtifact(
  tx: Prisma.TransactionClient,
  input: { workspaceId: string; artifactId: string },
): Promise<LockedArtifact> {
  const [artifact] = await tx.$queryRaw<LockedArtifact[]>`SELECT "id", "name", "title",
      "currentVersion", "homeKey", "access", "authorAgentId"
    FROM "artifacts"
    WHERE "id" = ${input.artifactId}::uuid AND "workspaceId" = ${input.workspaceId}::uuid
      AND "deletedAt" IS NULL
    FOR UPDATE`;
  if (!artifact) throw new AppError("NOT_FOUND");
  return artifact;
}

async function requireNarrowableHome(
  db: Tx,
  workspaceId: string,
  actor: ArtifactActor,
  artifact: LockedArtifact,
): Promise<string> {
  const conversationId = artifactHomeConversationId(artifact.homeKey);
  if (!conversationId)
    throw new AppError("INVALID_INPUT", {
      errorId: "artifact-access-tier",
      hint: "this artifact has no conversation to narrow back to",
    });
  const home = (await actorConversationHomeReads(db, workspaceId, actor, [conversationId])).get(
    conversationId,
  );
  if (!homeStands(home)) throw homeGone();
  return conversationId;
}

async function requireOwnerMayWiden(db: Tx, workspaceId: string, artifact: LockedArtifact) {
  const authorAgentOwnerId = await artifactAuthorOwnerId(db, artifact.authorAgentId);
  if (!authorAgentOwnerId) throw moveRefusal("no-owner");
  const owner = { userId: authorAgentOwnerId };
  const viewer = await artifactViewer(db, workspaceId, owner);
  if (!viewer.member) throw moveRefusal("no-owner");
  if (!(await artifactReadView(db, workspaceId, owner, artifact, { viewer, authorAgentOwnerId })))
    throw moveRefusal("owner-cannot-see");
  if (!canManageArtifactSharingWithRole(owner, viewer.role, { authorAgentOwnerId }))
    throw moveRefusal("owner-cannot-move");
}

async function writeTier(
  tx: Prisma.TransactionClient,
  artifact: LockedArtifact,
  from: ArtifactTier,
  to: ArtifactTier,
  actor: ArtifactActor,
) {
  await tx.$executeRaw`UPDATE "artifacts" SET "access" = ${to} WHERE "id" = ${artifact.id}::uuid`;
  await tx.artifactAccessEvent.create({
    data: {
      artifactId: artifact.id,
      from,
      to,
      ...(actor.agentId ? { actorAgentId: actor.agentId } : { actorUserId: actor.userId }),
    },
  });
}
