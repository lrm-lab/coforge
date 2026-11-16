import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import { ACTIVE_AGENT_WHERE } from "#src/server/agents/active-agent.server";
import {
  actorConversationHomeReads,
  agentsConversationHomeReads,
  actorsWithoutConversationRead,
  canReadConversationHome,
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
import { revokeArtifactPublicLinks } from "./artifact-public-links.server";
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

const lossChanged = () =>
  new AppError("CONFLICT", {
    errorId: "artifact-loss-changed",
    hint: "who would lose access changed since it was counted",
  });

const homeUnseen = () =>
  new AppError("NOT_FOUND", {
    errorId: "artifact-home-unseen",
    hint: "You can no longer see that conversation, so it can't go back.",
  });

const authorNotMember = () =>
  new AppError("CONFLICT", {
    errorId: "artifact-author-not-member",
    hint: "Its author is an Agent that is no longer in that conversation. Add the Agent back first.",
  });

const authorCannotSee = () =>
  new AppError("CONFLICT", {
    errorId: "artifact-author-cannot-see",
    hint: "Its author can no longer see it there, so it can't go back.",
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
    expectedLost?: number;
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
      if (input.tier === "conversation") {
        const { total } = await narrowing(tx, input.workspaceId, actor, artifact);
        if (input.expectedLost !== undefined && input.expectedLost !== total) throw lossChanged();
        await revokeArtifactPublicLinks(tx, artifact.id, input.userId);
      }
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
    return narrowing(this.db, input.workspaceId, actor, artifact);
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

async function narrowing(
  db: Tx,
  workspaceId: string,
  actor: ArtifactActor,
  artifact: LockedArtifact,
) {
  const conversationId = await requireNarrowableHome(db, workspaceId, actor, artifact);
  const [counts] = await Promise.all([
    actorsWithoutConversationRead(db, workspaceId, conversationId),
    requireAuthorKeepsAccess(db, workspaceId, conversationId, artifact),
  ]);
  if (!counts) throw homeGone();
  return { ...counts, total: counts.people + counts.agents };
}

async function requireAuthorKeepsAccess(
  db: Tx,
  workspaceId: string,
  conversationId: string,
  artifact: LockedArtifact,
) {
  const authorId = artifact.authorAgentId;
  if (!authorId) return;
  const [homes, active] = await Promise.all([
    agentsConversationHomeReads(db, workspaceId, conversationId, [authorId]),
    db.agent.findFirst({ where: { id: authorId, ...ACTIVE_AGENT_WHERE }, select: { id: true } }),
  ]);
  if (!active) throw authorCannotSee();
  const home = homes?.get(authorId);
  if (!home || !canReadConversationHome(home)) throw authorNotMember();
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
  if (!home || !canReadConversationHome(home)) throw homeUnseen();
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
