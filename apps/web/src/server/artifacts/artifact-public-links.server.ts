import type { PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import { artifactOpenableKind } from "#src/features/artifacts/artifact-path-kind";
import { artifactPageOrigin, artifactSandboxOrigin } from "./artifact-sandbox-config.server";
import {
  artifactAuthorOwnerId,
  artifactsDisabled,
  artifactsEnabled,
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

/** The types a public link serves: an artifact whose entry file is a web page or Markdown. */
const linkable = (entryPath: string) => artifactOpenableKind(entryPath) !== null;

export class ArtifactPublicLinks {
  constructor(
    private readonly db: PrismaClient,
    private readonly enabled: (workspaceId: string) => Promise<boolean> = (workspaceId) =>
      artifactsEnabled(db, workspaceId),
  ) {}

  /**
   * Whether an artifact can have a public link, and the one it has, for anyone who can read it.
   * None can be made while the sandbox origin is unset, nor for an entry that is neither a web
   * page nor Markdown. One the viewer
   * cannot read is refused just as one that does not exist is.
   */
  async read(input: { workspaceId: string; artifactId: string; userId: string }) {
    if (!(await this.enabled(input.workspaceId))) throw artifactsDisabled();
    const artifact = await this.db.artifact.findFirst({
      where: { id: input.artifactId, workspaceId: input.workspaceId, deletedAt: null },
      select: {
        homeKey: true,
        access: true,
        authorAgentId: true,
        entryPath: true,
        publicLinks: { where: { revokedAt: null }, select: { token: true } },
      },
    });
    if (!artifact) throw new AppError("NOT_FOUND");
    await requireArtifactRead(this.db, input.workspaceId, { userId: input.userId }, artifact);
    const origin = artifactSandboxOrigin();
    const live = artifact.publicLinks.at(0);
    return {
      available: origin !== null && linkable(artifact.entryPath),
      url:
        origin && live ? `${artifactPageOrigin(origin, input.artifactId)}/p/${live.token}` : null,
    };
  }

  async set(input: { workspaceId: string; artifactId: string; userId: string; enabled: boolean }) {
    const origin = artifactSandboxOrigin();
    if (!origin) throw new AppError("INVALID_INPUT", { errorId: "artifact-public-origin" });
    return this.db.$transaction(async (tx) => {
      const [artifact] = await tx.$queryRaw<
        {
          id: string;
          homeKey: string;
          access: string;
          authorAgentId: string | null;
          entryPath: string;
        }[]
      >`SELECT "id", "homeKey", "access", "authorAgentId", "entryPath" FROM "artifacts"
        WHERE "id" = ${input.artifactId}::uuid AND "workspaceId" = ${input.workspaceId}::uuid
          AND "deletedAt" IS NULL FOR UPDATE`;
      if (!artifact) throw new AppError("NOT_FOUND");
      if (input.enabled && !linkable(artifact.entryPath))
        throw new AppError("INVALID_INPUT", {
          errorId: "artifact-public-kind",
          hint: "public links support HTML and Markdown artifacts",
        });
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
        if (live)
          await tx.artifactPublicLink.updateMany({
            where: { artifactId: artifact.id, revokedAt: null },
            data: { revokedAt: new Date(), revokedByUserId: input.userId },
          });
        return { enabled: false as const };
      }
      if (live)
        return {
          enabled: true as const,
          url: `${artifactPageOrigin(origin, input.artifactId)}/p/${live.token}`,
        };
      const created = await tx.artifactPublicLink.create({
        data: { artifactId: artifact.id, token: mintToken(), createdByUserId: input.userId },
        select: { token: true },
      });
      return {
        enabled: true as const,
        url: `${artifactPageOrigin(origin, input.artifactId)}/p/${created.token}`,
      };
    });
  }
}
