import type { PrismaClient } from "#src/generated/prisma/client";
import { createCentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import { getFileStorage } from "#src/server/files/file-storage.server";
import { StoredArtifactBlobs } from "./artifact-blobs.server";
import { ArtifactDocuments } from "./artifact-documents.server";
import { centrifugoArtifactSignals } from "./artifact-signals.server";
import { Artifacts } from "./artifacts.server";
import { readSessionSecret } from "#src/server/auth/config.server";
import { ArtifactSandbox } from "./artifact-sandbox.server";
import { artifactSandboxOrigin } from "./artifact-sandbox-config.server";
import { ArtifactPublicLinks } from "./artifact-public-links.server";
import { artifactsEnabled } from "./artifact-access.server";

/** The artifact services of production: bytes in the private file bucket, each new version
 * announced over Centrifugo, the experiment read from the Workspace. */
export function productionArtifacts(db: PrismaClient) {
  const blobs = new StoredArtifactBlobs(db, getFileStorage);
  const artifacts = new Artifacts(db, blobs, {
    signals: centrifugoArtifactSignals(() => createCentrifugoServerApi()),
  });
  return {
    artifacts,
    blobs,
    documents: new ArtifactDocuments(db, artifacts, blobs),
    publicLinks: new ArtifactPublicLinks(db),
  };
}

/** Web pages on the sandbox origin (task #490): the same reads and bytes, signed with the
 * session secret, served from the configured origin. */
export function productionArtifactSandbox(db: PrismaClient) {
  const { artifacts, blobs } = productionArtifacts(db);
  return new ArtifactSandbox({
    reads: artifacts.reads,
    readBlob: (workspaceId, sha256) => blobs.read(workspaceId, sha256),
    origin: artifactSandboxOrigin(),
    secret: () => readSessionSecret(process.env),
    now: () => new Date(),
    publicPage: async (token) => {
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
            },
          },
        },
      });
      if (
        !link?.artifact ||
        link.artifact.deletedAt ||
        link.artifact.kind !== "html" ||
        link.artifact.currentVersion <= 0
      )
        return null;
      if (!(await artifactsEnabled(db, link.artifact.workspaceId))) return null;
      const version = await db.artifactVersion.findUnique({
        where: {
          artifactId_number: { artifactId: link.artifact.id, number: link.artifact.currentVersion },
        },
        select: { id: true, entryPath: true },
      });
      if (!version || version.entryPath !== link.artifact.entryPath) return null;
      const file = await db.artifactFile.findUnique({
        where: { versionId_path: { versionId: version.id, path: version.entryPath } },
        select: { sha256: true },
      });
      return file
        ? {
            workspaceId: link.artifact.workspaceId,
            artifactId: link.artifact.id,
            title: link.artifact.title,
            sha256: file.sha256,
          }
        : null;
    },
  });
}
