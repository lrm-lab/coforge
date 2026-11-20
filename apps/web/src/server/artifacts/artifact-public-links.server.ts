import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import { artifactPageOrigin, artifactSandboxOrigin } from "./artifact-sandbox-config.server";
import { announceAccessChange, type ArtifactSignals } from "./artifact-signals.server";
import {
  artifactAuthorOwnerId,
  artifactTier,
  canManageArtifactSharing,
  requireArtifactRead,
} from "./artifact-access.server";

function mintToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export async function revokeArtifactPublicLinks(
  tx: Prisma.TransactionClient,
  artifactId: string,
  userId: string,
) {
  await tx.artifactPublicLink.updateMany({
    where: { artifactId, revokedAt: null },
    data: { revokedAt: new Date(), revokedByUserId: userId },
  });
}

export class ArtifactPublicLinks {
  constructor(
    private readonly db: PrismaClient,
    private readonly signals?: ArtifactSignals,
  ) {}

  async read(input: { workspaceId: string; artifactId: string; userId: string }) {
    const artifact = await this.db.artifact.findFirst({
      where: { id: input.artifactId, workspaceId: input.workspaceId, deletedAt: null },
      select: {
        homeKey: true,
        access: true,
        authorAgentId: true,
        publicLinks: { where: { revokedAt: null }, select: { token: true } },
      },
    });
    if (!artifact) throw new AppError("NOT_FOUND");
    await requireArtifactRead(this.db, input.workspaceId, { userId: input.userId }, artifact);
    const origin = artifactSandboxOrigin();
    const live = artifact.publicLinks.at(0);
    return {
      available: origin !== null,
      url:
        origin && live ? `${artifactPageOrigin(origin, input.artifactId)}/p/${live.token}` : null,
    };
  }

  async set(input: { workspaceId: string; artifactId: string; userId: string; enabled: boolean }) {
    const origin = artifactSandboxOrigin();
    if (!origin) throw new AppError("INVALID_INPUT", { errorId: "artifact-public-origin" });
    const outcome = await this.db.$transaction(async (tx) => {
      const [artifact] = await tx.$queryRaw<
        {
          id: string;
          homeKey: string;
          access: string;
          authorAgentId: string | null;
        }[]
      >`SELECT "id", "homeKey", "access", "authorAgentId" FROM "artifacts"
        WHERE "id" = ${input.artifactId}::uuid AND "workspaceId" = ${input.workspaceId}::uuid
          AND "deletedAt" IS NULL FOR UPDATE`;
      if (!artifact) throw new AppError("NOT_FOUND");
      const actor = { userId: input.userId };
      const authorAgentOwnerId = await artifactAuthorOwnerId(tx, artifact.authorAgentId);
      await requireArtifactRead(tx, input.workspaceId, actor, artifact, { authorAgentOwnerId });
      if (!(await canManageArtifactSharing(tx, input.workspaceId, actor, { authorAgentOwnerId })))
        throw new AppError("ACCESS_DENIED");
      const live = await tx.artifactPublicLink.findFirst({
        where: { artifactId: artifact.id, revokedAt: null },
        select: { token: true },
      });
      if (!input.enabled) {
        if (live) await revokeArtifactPublicLinks(tx, artifact.id, input.userId);
        return { artifact, changed: live !== null, result: { enabled: false as const } };
      }
      const token =
        live?.token ??
        (
          await tx.artifactPublicLink.create({
            data: { artifactId: artifact.id, token: mintToken(), createdByUserId: input.userId },
            select: { token: true },
          })
        ).token;
      return {
        artifact,
        changed: live === null,
        result: {
          enabled: true as const,
          url: `${artifactPageOrigin(origin, input.artifactId)}/p/${token}`,
        },
      };
    });
    if (outcome.changed)
      await announceAccessChange(this.signals, {
        workspaceId: input.workspaceId,
        homeKey: outcome.artifact.homeKey,
        artifactId: outcome.artifact.id,
        tier: artifactTier(outcome.artifact),
      });
    return outcome.result;
  }
}
