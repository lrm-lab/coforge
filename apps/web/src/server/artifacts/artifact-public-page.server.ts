import type { PrismaClient } from "#src/generated/prisma/client";
import { artifactHomeHidden, artifactsEnabled } from "./artifact-access.server";
import {
  artifactKindOfPath,
  type ArtifactPathKind,
} from "#src/features/artifacts/artifact-path-kind";

export type PublicPage = {
  workspaceId: string;
  artifactId: string;
  title: string;
  kind: ArtifactPathKind;
  entryPath: string;
  sha256: string;
  sizeBytes: number;
};

type PageArtifact = {
  id: string;
  workspaceId: string;
  title: string;
  deletedAt: Date | null;
  currentVersion: number;
  entryPath: string;
  homeKey: string;
  access: string;
};

const PAGE_ARTIFACT_SELECT = {
  id: true,
  workspaceId: true,
  title: true,
  deletedAt: true,
  currentVersion: true,
  entryPath: true,
  homeKey: true,
  access: true,
} as const;

export function publicPageLookup(
  db: PrismaClient,
  enabled: (workspaceId: string) => Promise<boolean> = (workspaceId) =>
    artifactsEnabled(db, workspaceId),
) {
  return async (token: string, path?: string): Promise<PublicPage | null> => {
    const link = await db.artifactPublicLink.findFirst({
      where: { token, revokedAt: null },
      select: { artifact: { select: PAGE_ARTIFACT_SELECT } },
    });
    return link?.artifact ? publicPageOf(db, enabled, link.artifact, path) : null;
  };
}

export function linkPageLookup(
  db: PrismaClient,
  enabled: (workspaceId: string) => Promise<boolean> = (workspaceId) =>
    artifactsEnabled(db, workspaceId),
) {
  return async (artifactId: string, path?: string): Promise<PublicPage | null> => {
    const artifact = await db.artifact.findFirst({
      where: { id: artifactId, access: "link" },
      select: PAGE_ARTIFACT_SELECT,
    });
    return artifact ? publicPageOf(db, enabled, artifact, path) : null;
  };
}

async function publicPageOf(
  db: PrismaClient,
  enabled: (workspaceId: string) => Promise<boolean>,
  artifact: PageArtifact,
  path?: string,
): Promise<PublicPage | null> {
  if (artifact.deletedAt || artifact.currentVersion <= 0) return null;
  const [on, version, homeHidden] = await Promise.all([
    enabled(artifact.workspaceId),
    db.artifactVersion.findUnique({
      where: {
        artifactId_number: { artifactId: artifact.id, number: artifact.currentVersion },
      },
      select: {
        entryPath: true,
        files: {
          where: { path: path ?? artifact.entryPath },
          select: { sha256: true, sizeBytes: true },
        },
      },
    }),
    artifactHomeHidden(db, artifact.workspaceId, artifact),
  ]);
  const file = version?.files[0];
  if (!on || homeHidden || !version || version.entryPath !== artifact.entryPath || !file)
    return null;
  return {
    workspaceId: artifact.workspaceId,
    artifactId: artifact.id,
    title: artifact.title,
    kind: artifactKindOfPath(version.entryPath),
    entryPath: version.entryPath,
    sha256: file.sha256,
    sizeBytes: file.sizeBytes,
  };
}
