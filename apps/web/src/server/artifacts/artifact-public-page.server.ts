import type { PrismaClient } from "#src/generated/prisma/client";
import { artifactHomeHidden, artifactsEnabled } from "./artifact-access.server";

type PublicPage = {
  workspaceId: string;
  artifactId: string;
  title: string;
  kind: "html" | "markdown";
  entryPath: string;
  sha256: string;
};

/**
 * What a public link shows now (`ArtifactSandbox`'s `publicPage`): its artifact's current
 * version's entry path, and the sha256 of the file at `path` (the entry's when none is asked
 * for). Null when the link is revoked or unknown, the artifact is gone, not a web page or
 * document, or has no such file, or artifacts are off for its Workspace. Two reads, the second
 * with the file nested in it and run beside the experiment check.
 */
export function publicPageLookup(
  db: PrismaClient,
  enabled: (workspaceId: string) => Promise<boolean> = (workspaceId) =>
    artifactsEnabled(db, workspaceId),
) {
  return async (token: string, path?: string): Promise<PublicPage | null> => {
    const link = await db.artifactPublicLink.findFirst({
      where: { token, revokedAt: null },
      select: {
        artifact: {
          select: {
            id: true,
            workspaceId: true,
            title: true,
            kind: true,
            deletedAt: true,
            currentVersion: true,
            entryPath: true,
            homeKey: true,
          },
        },
      },
    });
    const artifact = link?.artifact;
    if (!artifact || artifact.deletedAt || artifact.currentVersion <= 0) return null;
    const kind =
      artifact.kind === "html" ? "html" : artifact.kind === "markdown" ? "markdown" : null;
    if (!kind) return null;
    const [on, version, homeHidden] = await Promise.all([
      enabled(artifact.workspaceId),
      db.artifactVersion.findUnique({
        where: {
          artifactId_number: { artifactId: artifact.id, number: artifact.currentVersion },
        },
        select: {
          entryPath: true,
          files: { where: { path: path ?? artifact.entryPath }, select: { sha256: true } },
        },
      }),
      // A home the Workspace hides is gone for everyone, its public page with it (task #20).
      artifactHomeHidden(db, artifact.workspaceId, artifact.homeKey),
    ]);
    const file = version?.files[0];
    if (!on || homeHidden || !version || version.entryPath !== artifact.entryPath || !file)
      return null;
    return {
      workspaceId: artifact.workspaceId,
      artifactId: artifact.id,
      title: artifact.title,
      kind,
      entryPath: version.entryPath,
      sha256: file.sha256,
    };
  };
}
