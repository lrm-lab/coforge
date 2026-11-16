import type { PrismaClient } from "#src/generated/prisma/client";
import { actorNames, actorOf } from "./artifact-actor-names.server";
import { changedPathsOf } from "./artifact-read-positions.server";
import type { ArtifactReads } from "./artifact-reads.server";

const CHANGED_PATHS_SHOWN = 10;
const VERSIONS_SHOWN = 100;

export class ArtifactVersionHistory {
  constructor(
    private readonly db: Pick<PrismaClient, "artifactVersion" | "agent" | "user">,
    private readonly reads: Pick<ArtifactReads, "artifact">,
  ) {}

  async list(input: { workspaceId: string; artifactId: string; userId: string }) {
    const artifact = await this.reads.artifact(input.workspaceId, input.artifactId, {
      userId: input.userId,
    });
    const rows = await this.db.artifactVersion.findMany({
      where: { artifactId: artifact.id },
      orderBy: { number: "desc" },
      take: VERSIONS_SHOWN,
      select: {
        number: true,
        note: true,
        title: true,
        createdAt: true,
        changedPaths: true,
        publisherAgentId: true,
        publisherUserId: true,
      },
    });
    const names = await actorNames(this.db, input.workspaceId, {
      userIds: rows.flatMap((row) => row.publisherUserId ?? []),
      agentIds: rows.flatMap((row) => row.publisherAgentId ?? []),
    });
    return rows.map(({ publisherAgentId, publisherUserId, changedPaths, ...version }) => {
      const paths = changedPathsOf(changedPaths);
      return {
        ...version,
        latest: version.number === artifact.currentVersion,
        publisher: actorOf(names, { userId: publisherUserId, agentId: publisherAgentId }),
        changedPaths: paths.slice(0, CHANGED_PATHS_SHOWN),
        changedCount: paths.length,
      };
    });
  }
}
