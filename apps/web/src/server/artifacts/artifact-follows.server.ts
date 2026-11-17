import type { PrismaClient } from "#src/generated/prisma/client";
import { requireReadableArtifact, type CommentedArtifact } from "./artifact-comment-access.server";

type Principal = { workspaceId: string; agentId: string };

const answer = (artifact: CommentedArtifact, following: boolean) => ({
  artifact: {
    id: artifact.id,
    name: artifact.name,
    title: artifact.title,
    currentVersion: artifact.currentVersion,
  },
  following,
});

export async function followArtifact(db: PrismaClient, principal: Principal, artifactId: string) {
  const artifact = await requireReadableArtifact(db, principal.workspaceId, principal, artifactId);
  const where = { artifactId_agentId: { artifactId: artifact.id, agentId: principal.agentId } };
  await db.artifactFollow.upsert({
    where,
    create: { artifactId: artifact.id, agentId: principal.agentId, following: true },
    update: { following: true, unfollowedAt: null },
  });
  return answer(artifact, true);
}

export async function unfollowArtifact(db: PrismaClient, principal: Principal, artifactId: string) {
  const artifact = await requireReadableArtifact(db, principal.workspaceId, principal, artifactId);
  const now = new Date();
  await db.artifactFollow.upsert({
    where: { artifactId_agentId: { artifactId: artifact.id, agentId: principal.agentId } },
    create: {
      artifactId: artifact.id,
      agentId: principal.agentId,
      following: false,
      unfollowedAt: now,
    },
    update: { following: false },
  });
  await db.artifactFollow.updateMany({
    where: { artifactId: artifact.id, agentId: principal.agentId, unfollowedAt: null },
    data: { unfollowedAt: now },
  });
  return answer(artifact, false);
}

export async function followByWriting(
  db: Pick<PrismaClient, "artifactFollow">,
  input: { artifactId: string; agentId: string },
): Promise<{ newlyFollowing: boolean }> {
  const where = { artifactId_agentId: input };
  const existing = await db.artifactFollow.findUnique({
    where,
    select: { following: true, unfollowedAt: true },
  });
  if (existing?.following || existing?.unfollowedAt) return { newlyFollowing: false };
  if (existing) {
    const revived = await db.artifactFollow.updateMany({
      where: { ...input, following: false, unfollowedAt: null },
      data: { following: true },
    });
    return { newlyFollowing: revived.count > 0 };
  }
  const created = await db.artifactFollow.createMany({
    data: [{ ...input, following: true }],
    skipDuplicates: true,
  });
  return { newlyFollowing: created.count > 0 };
}

export async function followerIds(
  db: Pick<PrismaClient, "artifactFollow">,
  artifactId: string,
): Promise<string[]> {
  const rows = await db.artifactFollow.findMany({
    where: { artifactId, following: true, agentId: { not: null } },
    select: { agentId: true },
  });
  return rows.flatMap((row) => (row.agentId ? [row.agentId] : []));
}

type PersonFollows = Pick<PrismaClient, "$executeRaw">;

export async function startFollowing(
  db: PersonFollows,
  artifactId: string,
  people: readonly { userId: string; at?: Date }[],
): Promise<void> {
  if (people.length === 0) return;
  await db.$executeRaw`
    INSERT INTO "artifact_follows" ("id", "artifactId", "userId", "following", "followedAt", "updatedAt")
    SELECT gen_random_uuid(), ${artifactId}::uuid, wanted."userId", TRUE,
      COALESCE(wanted."at", (now() AT TIME ZONE 'UTC')), COALESCE(wanted."at", (now() AT TIME ZONE 'UTC'))
    FROM unnest(${people.map(({ userId }) => userId)}::uuid[], ${people.map(({ at }) => at?.toISOString() ?? null)}::timestamp[])
      AS wanted("userId", "at")
    ON CONFLICT ("artifactId", "userId") DO UPDATE
    SET "following" = TRUE, "unfollowedAt" = NULL, "followedAt" = EXCLUDED."followedAt",
      "updatedAt" = EXCLUDED."updatedAt"
    WHERE NOT "artifact_follows"."following"`;
}
