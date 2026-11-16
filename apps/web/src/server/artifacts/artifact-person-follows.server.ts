import type { PrismaClient } from "#src/generated/prisma/client";
import type { ArtifactReads } from "./artifact-reads.server";

type Scope = { workspaceId: string; artifactId: string; userId: string };

export class ArtifactPersonFollows {
  constructor(
    private readonly db: Pick<PrismaClient, "artifactFollow">,
    private readonly reads: Pick<ArtifactReads, "artifact">,
  ) {}

  async read(input: Scope): Promise<boolean> {
    const artifact = await this.reads.artifact(input.workspaceId, input.artifactId, {
      userId: input.userId,
    });
    const row = await this.db.artifactFollow.findUnique({
      where: { artifactId_userId: { artifactId: artifact.id, userId: input.userId } },
      select: { following: true },
    });
    return row?.following === true;
  }

  async set(input: Scope & { following: boolean }): Promise<boolean> {
    const artifact = await this.reads.artifact(input.workspaceId, input.artifactId, {
      userId: input.userId,
    });
    const where = { artifactId_userId: { artifactId: artifact.id, userId: input.userId } };
    const unfollowedAt = input.following ? null : new Date();
    await this.db.artifactFollow.upsert({
      where,
      create: {
        artifactId: artifact.id,
        userId: input.userId,
        following: input.following,
        unfollowedAt,
      },
      update: { following: input.following, unfollowedAt },
    });
    return input.following;
  }
}
