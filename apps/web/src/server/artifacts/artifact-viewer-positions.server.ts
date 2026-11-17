import type { PrismaClient } from "#src/generated/prisma/client";
import { ARTIFACT_ROSTER_SIZE } from "#src/features/artifacts/artifact-presence-channel";
import { actorDirectory } from "./artifact-actor-names.server";
import { artifactUnreadKeysSql } from "./artifact-activity.server";
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
    return this.#rosterOf(artifact, input, []);
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

  async roster(input: Place & { viewing?: readonly string[] | undefined }) {
    const artifact = await this.reads.artifact(input.workspaceId, input.artifactId, {
      userId: input.userId,
    });
    return this.#rosterOf(artifact, input, input.viewing ?? []);
  }

  async #rosterOf(
    artifact: { id: string; currentVersion: number },
    input: Place,
    viewing: readonly string[],
  ) {
    const select = { userId: true, openedAt: true, seenVersion: true } as const;
    const [latest, watching] = await Promise.all([
      this.db.artifactViewerPosition.findMany({
        where: { artifactId: artifact.id },
        select,
        orderBy: { openedAt: "desc" },
        take: ARTIFACT_ROSTER_SIZE,
      }),
      viewing.length
        ? this.db.artifactViewerPosition.findMany({
            where: { artifactId: artifact.id, userId: { in: [...viewing] } },
            select,
          })
        : [],
    ]);
    const rows = [
      ...new Map([...latest, ...watching].map((row) => [row.userId, row])).values(),
    ].sort((a, b) => b.openedAt.getTime() - a.openedAt.getTime());
    const { names, faces } = await actorDirectory(this.db, input.workspaceId, {
      userIds: rows.map((row) => row.userId),
      agentIds: [],
    });
    return {
      you: input.userId,
      currentVersion: artifact.currentVersion,
      seen: rows.map((row) => ({
        ...row,
        name: names.get(row.userId) ?? "",
        avatarUrl: faces.get(row.userId) ?? null,
      })),
      behind: rows.filter(
        (row) => row.userId !== input.userId && row.seenVersion < artifact.currentVersion,
      ).length,
    };
  }
}
