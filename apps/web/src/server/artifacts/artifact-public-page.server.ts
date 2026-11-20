import type { PrismaClient } from "#src/generated/prisma/client";
import { artifactHomeHidden } from "./artifact-access.server";
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
  access: string;
  version: number;
  updatedAt?: string;
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

export function publicPageLookup(db: PrismaClient) {
  return async (token: string, path?: string): Promise<PublicPage | null> => {
    const link = await db.artifactPublicLink.findFirst({
      where: { token, revokedAt: null },
      select: { artifact: { select: PAGE_ARTIFACT_SELECT } },
    });
    return link?.artifact ? publicPageOf(db, link.artifact, path) : null;
  };
}

export type LinkLookup = { shared: boolean; page: PublicPage | null };

export function linkPageLookup(db: PrismaClient) {
  return async (artifactId: string, path?: string): Promise<LinkLookup> => {
    const artifact = await db.artifact.findFirst({
      where: {
        id: artifactId,
        deletedAt: null,
        OR: [{ access: "link" }, { publicLinks: { some: { revokedAt: null } } }],
      },
      select: PAGE_ARTIFACT_SELECT,
    });
    return artifact
      ? { shared: true, page: await publicPageOf(db, artifact, path) }
      : { shared: false, page: null };
  };
}

export async function memberArtifactWorkspaceSlug(
  db: PrismaClient,
  artifactId: string,
  userId: string,
): Promise<string | null> {
  const artifact = await db.artifact.findFirst({
    where: {
      id: artifactId,
      deletedAt: null,
      workspace: { members: { some: { userId } } },
    },
    select: { workspace: { select: { slug: true } } },
  });
  return artifact?.workspace.slug ?? null;
}

async function publicPageOf(
  db: PrismaClient,
  artifact: PageArtifact,
  path?: string,
): Promise<PublicPage | null> {
  if (artifact.deletedAt || artifact.currentVersion <= 0) return null;
  const [version, homeHidden] = await Promise.all([
    db.artifactVersion.findUnique({
      where: {
        artifactId_number: { artifactId: artifact.id, number: artifact.currentVersion },
      },
      select: {
        entryPath: true,
        createdAt: true,
        files: {
          where: { path: path ?? artifact.entryPath },
          select: { sha256: true, sizeBytes: true },
        },
      },
    }),
    artifactHomeHidden(db, artifact.workspaceId, artifact),
  ]);
  const file = version?.files[0];
  if (homeHidden || !version || version.entryPath !== artifact.entryPath || !file) return null;
  return {
    workspaceId: artifact.workspaceId,
    artifactId: artifact.id,
    title: artifact.title,
    kind: artifactKindOfPath(version.entryPath),
    entryPath: version.entryPath,
    sha256: file.sha256,
    sizeBytes: file.sizeBytes,
    access: artifact.access,
    version: artifact.currentVersion,
    updatedAt: version.createdAt.toISOString(),
  };
}
