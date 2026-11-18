import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import { artifactPageOrigin, artifactSandboxOrigin } from "./artifact-sandbox-config.server";
import { announceAccessChange, type ArtifactSignals } from "./artifact-signals.server";
import {
  artifactAuthorOwnerId,
  artifactsDisabled,
  artifactsEnabled,
  artifactTier,
  artifactReadView,
  canManageArtifactSharing,
  requireArtifactRead,
} from "./artifact-access.server";
import { publicPageLookup } from "./artifact-public-page.server";

function mintToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

const publicLinkUrl = (origin: string, artifactId: string, token: string) =>
  `${artifactPageOrigin(origin, artifactId)}/p/${token}`;

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
    private readonly enabled: (workspaceId: string) => Promise<boolean> = (workspaceId) =>
      artifactsEnabled(db, workspaceId),
    private readonly signals?: ArtifactSignals,
  ) {}

  async visitorUrl(input: {
    workspaceSlug: string;
    artifactId: string;
    reader: () => Promise<string | null>;
  }): Promise<string | null> {
    const origin = artifactSandboxOrigin();
    if (!origin) return null;
    const live = await this.db.artifactPublicLink.findFirst({
      where: {
        artifactId: input.artifactId,
        revokedAt: null,
        artifact: { workspace: { slug: input.workspaceSlug } },
      },
      select: {
        token: true,
        artifact: {
          select: { workspaceId: true, homeKey: true, access: true, authorAgentId: true },
        },
      },
    });
    if (!live) return null;
    const [servable, userId] = await Promise.all([
      publicPageLookup(this.db, this.enabled)(live.token),
      input.reader(),
    ]);
    if (!servable) return null;
    if (
      userId !== null &&
      (await artifactReadView(this.db, live.artifact.workspaceId, { userId }, live.artifact))
    )
      return null;
    return publicLinkUrl(origin, input.artifactId, live.token);
  }

  async read(input: { workspaceId: string; artifactId: string; userId: string }) {
    if (!(await this.enabled(input.workspaceId))) throw artifactsDisabled();
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
      url: origin && live ? publicLinkUrl(origin, input.artifactId, live.token) : null,
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
          url: publicLinkUrl(origin, input.artifactId, token),
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
