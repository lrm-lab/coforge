import { randomUUID } from "node:crypto";

import type { PrismaClient } from "#src/generated/prisma/client";
import { ARTIFACT_TITLE_MAX } from "#src/features/artifacts/artifact-title-limit";
import { AppError } from "#src/lib/app-error";
import { errorType } from "#src/server/errors/error-type.server";
import { actorNames } from "./artifact-actor-names.server";
import type { ArtifactNoticePort } from "./artifact-notice-port.server";
import { ArtifactNotices } from "./artifact-notices.server";
import type { ArtifactReads } from "./artifact-reads.server";

export class ArtifactRenames {
  constructor(
    private readonly db: PrismaClient,
    private readonly reads: Pick<ArtifactReads, "artifact">,
    private readonly notices?: ArtifactNoticePort,
  ) {}

  async rename(input: { workspaceId: string; artifactId: string; userId: string; title: string }) {
    const title = input.title.trim();
    if (!title || [...title].length > ARTIFACT_TITLE_MAX)
      throw new AppError("INVALID_INPUT", { errorId: "artifact-title" });
    const read = await this.reads.artifact(input.workspaceId, input.artifactId, {
      userId: input.userId,
    });
    if (!read.canChange) throw new AppError("ACCESS_DENIED");
    const from = await this.db.$transaction(async (tx) => {
      const [locked] = await tx.$queryRaw<{ title: string; currentVersion: number }[]>`
        SELECT "title", "currentVersion" FROM "artifacts"
        WHERE "id" = ${read.id}::uuid AND "workspaceId" = ${input.workspaceId}::uuid
          AND "deletedAt" IS NULL
        FOR UPDATE`;
      if (!locked) throw new AppError("NOT_FOUND");
      if (locked.title === title) return null;
      await tx.artifact.update({ where: { id: read.id }, data: { title } });
      await tx.artifactVersion.updateMany({
        where: { artifactId: read.id, number: locked.currentVersion },
        data: { title },
      });
      return locked.title;
    });
    if (from === null) return { id: read.id, title, from: title, changed: false };
    await this.tellFollowers({ ...input, from, key: randomUUID() });
    return { id: read.id, title, from, changed: true };
  }

  private async tellFollowers(input: {
    workspaceId: string;
    artifactId: string;
    userId: string;
    from: string;
    key: string;
  }) {
    if (!this.notices) return;
    try {
      await this.tell(input, this.notices);
    } catch (error) {
      console.warn(
        JSON.stringify({ event: "artifacts:notices_failed", error_type: errorType(error) }),
      );
    }
  }

  private async tell(
    input: {
      workspaceId: string;
      artifactId: string;
      userId: string;
      from: string;
      key: string;
    },
    port: ArtifactNoticePort,
  ) {
    const [artifact, names] = await Promise.all([
      this.db.artifact.findUniqueOrThrow({
        where: { id: input.artifactId },
        select: {
          id: true,
          name: true,
          title: true,
          homeKey: true,
          access: true,
          authorAgentId: true,
        },
      }),
      actorNames(this.db, input.workspaceId, { userIds: [input.userId], agentIds: [] }),
    ]);
    await new ArtifactNotices(this.db, port).rename({
      workspaceId: input.workspaceId,
      artifact,
      writerName: names.get(input.userId) ?? "someone",
      from: input.from,
      to: artifact.title,
      key: input.key,
    });
  }
}
