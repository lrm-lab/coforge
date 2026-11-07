import type { PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import { artifactSandboxOrigin } from "./artifact-sandbox-config.server";
import {
  artifactReadAccess,
  artifactsDisabled,
  artifactsEnabled,
  canChangeArtifactAccess,
} from "./artifact-access.server";

function mintToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

const LINKABLE_KINDS = ["html", "markdown"];

export class ArtifactPublicLinks {
  constructor(
    private readonly db: PrismaClient,
    private readonly enabled: (workspaceId: string) => Promise<boolean> = (workspaceId) =>
      artifactsEnabled(db, workspaceId),
  ) {}

  /**
   * Whether an artifact can have a public link, and the one it has, for anyone who can read it.
   * None can be made while the sandbox origin is unset, nor for other kinds. One the viewer
   * cannot read is refused just as one that does not exist is.
   */
  async read(input: { workspaceId: string; artifactId: string; userId: string }) {
    if (!(await this.enabled(input.workspaceId))) throw artifactsDisabled();
    const artifact = await this.db.artifact.findFirst({
      where: { id: input.artifactId, workspaceId: input.workspaceId, deletedAt: null },
      select: {
        homeKey: true,
        access: true,
        kind: true,
        publicLinks: { where: { revokedAt: null }, select: { token: true } },
      },
    });
    if (
      !artifact ||
      !(await artifactReadAccess(this.db, input.workspaceId, { userId: input.userId }, artifact))
    )
      throw new AppError("NOT_FOUND");
    const origin = artifactSandboxOrigin();
    const live = artifact.publicLinks.at(0);
    return {
      available: origin !== null && LINKABLE_KINDS.includes(artifact.kind),
      url: origin && live ? `${origin}/p/${live.token}` : null,
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
          authorUserId: string | null;
          authorAgentId: string | null;
          kind: string;
        }[]
      >`SELECT "id", "homeKey", "access", "authorUserId", "authorAgentId", "kind" FROM "artifacts"
        WHERE "id" = ${input.artifactId}::uuid AND "workspaceId" = ${input.workspaceId}::uuid
          AND "deletedAt" IS NULL FOR UPDATE`;
      if (!artifact) throw new AppError("NOT_FOUND");
      if (input.enabled && !LINKABLE_KINDS.includes(artifact.kind))
        throw new AppError("INVALID_INPUT", {
          errorId: "artifact-public-kind",
          hint: "public links support HTML and Markdown artifacts",
        });
      if (!(await artifactReadAccess(tx, input.workspaceId, { userId: input.userId }, artifact)))
        throw new AppError("NOT_FOUND");
      const ownerId = artifact.authorAgentId
        ? (
            await tx.agent.findFirst({
              where: { id: artifact.authorAgentId },
              select: { ownerId: true },
            })
          )?.ownerId
        : null;
      if (
        !(await canChangeArtifactAccess(
          tx,
          input.workspaceId,
          { userId: input.userId },
          {
            authorUserId: artifact.authorUserId,
            authorAgentId: artifact.authorAgentId,
            authorAgentOwnerId: ownerId ?? null,
          },
        ))
      )
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
      if (live) return { enabled: true as const, url: `${origin}/p/${live.token}` };
      const created = await tx.artifactPublicLink.create({
        data: { artifactId: artifact.id, token: mintToken(), createdByUserId: input.userId },
        select: { token: true },
      });
      return { enabled: true as const, url: `${origin}/p/${created.token}` };
    });
  }
}
