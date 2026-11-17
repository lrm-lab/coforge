import type { PrismaClient } from "#src/generated/prisma/client";
import { actorNames } from "./artifact-actor-names.server";
import { artifactUnreadKeysSql } from "./artifact-activity.server";
import type { ArtifactViewing } from "./artifact-viewing.server";
import type { ArtifactReads } from "./artifact-reads.server";

type PositionsDb = Pick<
  PrismaClient,
  "artifactViewerPosition" | "user" | "agent" | "$executeRaw" | "$queryRaw"
>;

type Place = { workspaceId: string; artifactId: string; userId: string };

export class ArtifactViewerPositions {
  constructor(
    private readonly db: PositionsDb,
    private readonly reads: Pick<ArtifactReads, "artifact">,
    private readonly viewing: ArtifactViewing,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async open(input: Place & { version?: number }) {
    const artifact = await this.reads.artifact(input.workspaceId, input.artifactId, {
      userId: input.userId,
    });
    const seen = Math.min(input.version ?? artifact.currentVersion, artifact.currentVersion);
    await this.db.$executeRaw`
      INSERT INTO "artifact_viewer_positions" ("artifactId", "userId", "openedAt", "seenVersion")
      VALUES (${artifact.id}::uuid, ${input.userId}::uuid, ${this.now()}, ${seen})
      ON CONFLICT ("artifactId", "userId") DO UPDATE
      SET "openedAt" = EXCLUDED."openedAt",
          "seenVersion" = GREATEST("artifact_viewer_positions"."seenVersion", EXCLUDED."seenVersion")`;
    await this.viewing.mark(artifact.id, input.userId);
    return this.#rosterOf(artifact, input);
  }

  async seen(input: Place): Promise<boolean> {
    await this.reads.artifact(input.workspaceId, input.artifactId, { userId: input.userId });
    const unread = await this.db.$queryRaw<unknown[]>(
      artifactUnreadKeysSql(input.workspaceId, input.userId, input.artifactId),
    );
    await this.db.artifactViewerPosition.updateMany({
      where: { artifactId: input.artifactId, userId: input.userId },
      data: { openedAt: this.now() },
    });
    return unread.length > 0;
  }

  async heartbeat(input: Place) {
    await this.reads.artifact(input.workspaceId, input.artifactId, { userId: input.userId });
    await this.viewing.mark(input.artifactId, input.userId);
  }

  async roster(input: Place) {
    const artifact = await this.reads.artifact(input.workspaceId, input.artifactId, {
      userId: input.userId,
    });
    return this.#rosterOf(artifact, input);
  }

  async #rosterOf(artifact: { id: string; currentVersion: number }, input: Place) {
    const [rows, nowIds] = await Promise.all([
      this.db.artifactViewerPosition.findMany({
        where: { artifactId: artifact.id },
        select: { userId: true, openedAt: true, seenVersion: true },
        orderBy: { openedAt: "desc" },
        take: 50,
      }),
      this.viewing.now(artifact.id),
    ]);
    const names = await actorNames(this.db, input.workspaceId, {
      userIds: [...rows.map((row) => row.userId), ...nowIds],
      agentIds: [],
    });
    const named = (id: string) => ({ userId: id, name: names.get(id) ?? "" });
    return {
      you: input.userId,
      currentVersion: artifact.currentVersion,
      viewingNow: nowIds.map(named),
      seen: rows.map((row) => ({ ...named(row.userId), ...row })),
      behind: rows.filter(
        (row) => row.userId !== input.userId && row.seenVersion < artifact.currentVersion,
      ).length,
    };
  }
}
