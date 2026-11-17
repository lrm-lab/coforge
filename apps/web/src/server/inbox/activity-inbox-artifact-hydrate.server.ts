import type { PrismaClient } from "#src/generated/prisma/client";
import { artifactActivityDetails } from "#src/server/artifacts/artifact-activity.server";
import {
  artifactActivityRowsSql,
  type ArtifactActivityRow,
  type ArtifactListedRow,
} from "#src/server/artifacts/artifact-activity.server";
import { browserActors } from "#src/server/conversations/sender-display.server";

type DetailDb = Pick<
  PrismaClient,
  | "artifact"
  | "artifactComment"
  | "artifactCommentReview"
  | "artifactVersion"
  | "artifactCommentImage"
  | "user"
  | "agent"
  | "$queryRaw"
>;

type ListedArtifact = ArtifactListedRow & { artifactId: string; key: string; latestAt: Date };

export const isListedArtifact = (row: ArtifactListedRow): row is ListedArtifact =>
  row.artifactId !== null;

export async function hydrateArtifactItems(
  db: DetailDb,
  workspaceId: string,
  userId: string,
  listed: readonly ListedArtifact[],
) {
  if (listed.length === 0) return [];
  const facts = await db.$queryRaw<ArtifactActivityRow[]>(
    artifactActivityRowsSql(
      workspaceId,
      userId,
      listed.map((row) => row.artifactId),
    ),
  );
  const details = await artifactActivityDetails(db, workspaceId, facts);
  const factsOf = new Map(facts.map((row) => [row.artifactId, row]));
  const actorOf = await browserActors(db, workspaceId, {
    userIds: [...details.values()].flatMap((detail) => detail.authorUserId ?? []),
    agentIds: [...details.values()].flatMap((detail) => detail.authorAgentId ?? []),
  });
  return listed.flatMap((row) => {
    const detail = details.get(row.artifactId);
    const fact = factsOf.get(row.artifactId);
    if (!detail || !fact) return [];
    return [
      {
        kind: "artifact" as const,
        key: row.key,
        at: row.latestAt,
        artifact: {
          id: detail.artifact.id,
          title: detail.artifact.title || detail.artifact.name,
          entryPath: detail.artifact.entryPath,
        },
        event: {
          kind: detail.kind,
          mentioned: detail.mentioned,
          preview: detail.preview,
          imageCount: detail.imageCount,
          reviewComments: detail.reviewComments,
          version: detail.version,
          actor: actorOf({ userId: detail.authorUserId, agentId: detail.authorAgentId }),
        },
        target: detail.target,
        unreadCount: fact.unreadComments + fact.unreadVersions,
        unreadMention: row.unreadMention ?? false,
      },
    ];
  });
}

export type ActivityArtifactItem = Awaited<ReturnType<typeof hydrateArtifactItems>>[number];
