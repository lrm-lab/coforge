import type { PrismaClient } from "#src/generated/prisma/client";
import { createCentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import { getFileStorage } from "#src/server/files/file-storage.server";
import { StoredArtifactBlobs } from "./artifact-blobs.server";
import { ArtifactDocuments } from "./artifact-documents.server";
import { centrifugoArtifactSignals } from "./artifact-signals.server";
import { Artifacts } from "./artifacts.server";
import { readSessionSecret } from "#src/server/auth/config.server";
import { actorNames } from "./artifact-actor-names.server";
import { ArtifactSandbox } from "./artifact-sandbox.server";
import { productionTicketNonces } from "./artifact-sandbox-nonces.server";
import { artifactSandboxOrigin } from "./artifact-sandbox-config.server";
import { ArtifactPublicLinks } from "./artifact-public-links.server";
import { publicPageLookup } from "./artifact-public-page.server";
import { getAppRateLimits } from "#src/server/app-rate-limits/app-rate-limits-composition.server";
import type { ArtifactActor } from "./artifact-access.server";
import type { ArtifactMessageCard } from "./artifact-reads.server";
import { ArtifactShares } from "./artifact-shares.server";
import type { ArtifactNoticePort } from "./artifact-notice-port.server";
import { createSystemAgentEvents } from "#src/server/app-agent-events/app-agent-events-composition.server";
export type { ArtifactMessageCard } from "./artifact-reads.server";

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
    visibility: artifacts.visibility,
    publicLinks: new ArtifactPublicLinks(db),
  };
}

export function productionArtifactNotices(db: PrismaClient): ArtifactNoticePort {
  const events = createSystemAgentEvents(db);
  return {
    deliver: ({ workspaceId, agentId, key, content }) =>
      events.deliver({
        source: "system.artifacts",
        sourceName: "CoForge artifacts",
        workspaceId,
        agentId,
        key,
        message: content,
      }),
  };
}

export function productionArtifactShares(
  db: PrismaClient,
  enabled: (workspaceId: string) => Promise<boolean>,
) {
  return new ArtifactShares(db, enabled);
}

export function productionArtifactSandbox(db: PrismaClient) {
  const { artifacts, blobs } = productionArtifacts(db);
  return new ArtifactSandbox({
    reads: artifacts.reads,
    readBlob: (workspaceId, sha256) => blobs.read(workspaceId, sha256),
    origin: artifactSandboxOrigin(),
    nonces: productionTicketNonces(),
    viewerName: async (workspaceId, userId) =>
      (await actorNames(db, workspaceId, { userIds: [userId], agentIds: [] })).get(userId) ?? "",
    publicRateLimit: getAppRateLimits().publicArtifact,
    publicFileRateLimit: getAppRateLimits().publicArtifactFile,
    secret: () => readSessionSecret(process.env),
    now: () => new Date(),
    publicPage: publicPageLookup(db),
  });
}

/** Batched live card projection for a page of browser messages. */
export function artifactMessageCards(
  db: PrismaClient,
  input: {
    workspaceId: string;
    reader: ArtifactActor;
    messages: readonly { body: string }[];
  },
): Promise<ArtifactMessageCard[][]> {
  return productionArtifacts(db).artifacts.reads.messageCards(input);
}
