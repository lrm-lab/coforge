import type { PrismaClient } from "#src/generated/prisma/client";
import { startFollowing } from "./artifact-follows.server";
import type { ArtifactReads } from "./artifact-reads.server";

type Scope = { workspaceId: string; artifactId: string; userId: string };

export class ArtifactPersonFollows {
  constructor(
    private readonly db: Pick<PrismaClient, "artifactFollow" | "$executeRaw">,
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
    if (input.following) {
      await startFollowing(this.db, artifact.id, [{ userId: input.userId }]);
      return true;
    }
    const unfollowedAt = new Date();
    await this.db.artifactFollow.upsert({
      where: { artifactId_userId: { artifactId: artifact.id, userId: input.userId } },
      create: { artifactId: artifact.id, userId: input.userId, following: false, unfollowedAt },
      update: { following: false, unfollowedAt },
    });
    return false;
  }
}
