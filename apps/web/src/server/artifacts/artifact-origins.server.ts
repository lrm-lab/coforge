import { Prisma, type PrismaClient } from "#src/generated/prisma/client";
import { artifactIdsInBody } from "#src/features/artifacts/artifact-link";
import { errorType } from "#src/server/errors/error-type.server";

const MAX_LINKED = 3;

export class ArtifactOrigins {
  constructor(private readonly db: Pick<PrismaClient, "$executeRaw">) {}

  async noteMessage(input: {
    workspaceId: string;
    conversationId: string;
    messageId: string;
    body: string;
    createdAt: Date;
    replaceLater?: boolean;
  }): Promise<number> {
    if (
      !input.body.includes("artifacts/") &&
      !input.body.includes("/a/") &&
      !input.body.includes("doc=")
    )
      return 0;
    const ids = artifactIdsInBody(input.body, MAX_LINKED);
    if (ids.length === 0) return 0;
    const vacant = input.replaceLater
      ? Prisma.sql`("originMessageId" IS NULL OR "originMessageId" > ${input.messageId}::uuid)`
      : Prisma.sql`"originMessageId" IS NULL`;
    try {
      return await this.db
        .$executeRaw`UPDATE "artifacts" SET "originMessageId" = ${input.messageId}::uuid
        WHERE "id" = ANY(${ids}::uuid[]) AND "workspaceId" = ${input.workspaceId}::uuid
          AND ${vacant} AND "deletedAt" IS NULL
          AND "homeKey" = ${`conversation:${input.conversationId}`}
          AND "createdAt" <= ${input.createdAt}`;
    } catch (error) {
      console.warn(
        JSON.stringify({ event: "artifacts:origin_note_failed", error_type: errorType(error) }),
      );
      return 0;
    }
  }
}
