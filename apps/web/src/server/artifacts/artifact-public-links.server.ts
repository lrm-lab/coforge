import type { PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import { artifactSandboxOrigin } from "./artifact-sandbox-config.server";
import { artifactReadAccess, canChangeArtifactAccess } from "./artifact-access.server";

function mintToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export class ArtifactPublicLinks {
  constructor(private readonly db: PrismaClient) {}

  async set(input: { workspaceId: string; artifactId: string; userId: string; enabled: boolean }) {
    const origin = artifactSandboxOrigin();
    if (!origin) throw new AppError("INVALID_INPUT", { errorId: "artifact-public-origin" });
    return this.db.$transaction(async (tx) => {
      const [artifact] = await tx.$queryRaw<
        { id: string; homeKey: string; access: string; authorUserId: string | null; authorAgentId: string | null }[]
      >`SELECT "id", "homeKey", "access", "authorUserId", "authorAgentId" FROM "artifacts"
        WHERE "id" = ${input.artifactId}::uuid AND "workspaceId" = ${input.workspaceId}::uuid
          AND "deletedAt" IS NULL FOR UPDATE`;
      if (!artifact) throw new AppError("NOT_FOUND");
      if (!(await artifactReadAccess(tx, input.workspaceId, { userId: input.userId }, artifact)))
        throw new AppError("NOT_FOUND");
      const ownerId = artifact.authorAgentId
        ? (await tx.agent.findFirst({ where: { id: artifact.authorAgentId }, select: { ownerId: true } }))?.ownerId
        : null;
      if (!(await canChangeArtifactAccess(tx, input.workspaceId, { userId: input.userId }, {
        authorUserId: artifact.authorUserId,
        authorAgentId: artifact.authorAgentId,
        authorAgentOwnerId: ownerId ?? null,
      }))) throw new AppError("ACCESS_DENIED");
      const live = await tx.artifactPublicLink.findFirst({ where: { artifactId: artifact.id, revokedAt: null }, select: { token: true } });
      if (!input.enabled) {
        if (live) await tx.artifactPublicLink.updateMany({ where: { artifactId: artifact.id, revokedAt: null }, data: { revokedAt: new Date(), revokedByUserId: input.userId } });
        return { enabled: false as const };
      }
      if (live) return { enabled: true as const, url: `${origin}/p/${live.token}` };
      const created = await tx.artifactPublicLink.create({ data: { artifactId: artifact.id, token: mintToken(), createdByUserId: input.userId }, select: { token: true } });
      return { enabled: true as const, url: `${origin}/p/${created.token}` };
    });
  }
}
