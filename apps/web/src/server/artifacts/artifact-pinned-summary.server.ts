import type { PrismaClient } from "#src/generated/prisma/client";
import {
  artifactKindOfPath,
  type ArtifactPathKind,
} from "#src/features/artifacts/artifact-path-kind";
import { actorDirectory } from "./artifact-actor-names.server";

export type PinnedArtifactActor = {
  kind: "user" | "agent";
  id: string;
  name: string;
  avatarUrl?: string;
};

export type PinnedArtifactSummary = {
  artifactId: string;
  title: string;
  entryPath: string;
  entryKind: ArtifactPathKind;
  version: number;
  note: string;
  preview: string;
  updatedAt: string;
  updatedBy: PinnedArtifactActor | null;
  seen: boolean;
};

type PinnedSummaryDb = Pick<
  PrismaClient,
  "artifact" | "artifactVersion" | "artifactViewerPosition" | "agent" | "user"
>;

export class ArtifactPinnedSummary {
  constructor(private readonly db: PinnedSummaryDb) {}

  async verifyHomedInConversation(input: {
    workspaceId: string;
    conversationId: string;
    artifactId: string;
  }): Promise<{ id: string; title: string } | null> {
    const row = await this.db.artifact.findFirst({
      where: {
        id: input.artifactId,
        workspaceId: input.workspaceId,
        homeKey: `conversation:${input.conversationId}`,
        deletedAt: null,
      },
      select: { id: true, title: true },
    });
    return row ?? null;
  }

  async read(input: {
    workspaceId: string;
    conversationId: string;
    artifactId: string;
    userId: string;
  }): Promise<PinnedArtifactSummary | null> {
    const artifact = await this.db.artifact.findFirst({
      where: {
        id: input.artifactId,
        workspaceId: input.workspaceId,
        homeKey: `conversation:${input.conversationId}`,
        deletedAt: null,
      },
      select: {
        id: true,
        title: true,
        entryPath: true,
        currentVersion: true,
        preview: true,
        authorAgentId: true,
        updatedAt: true,
      },
    });
    if (!artifact) return null;

    const [latestVersion, viewerPosition] = await Promise.all([
      artifact.currentVersion > 0
        ? this.db.artifactVersion.findUnique({
            where: {
              artifactId_number: { artifactId: artifact.id, number: artifact.currentVersion },
            },
            select: {
              note: true,
              publisherUserId: true,
              publisherAgentId: true,
              createdAt: true,
            },
          })
        : null,
      this.db.artifactViewerPosition.findUnique({
        where: { artifactId_userId: { artifactId: artifact.id, userId: input.userId } },
        select: { seenVersion: true },
      }),
    ]);

    const updaterAgentId = latestVersion?.publisherAgentId ?? artifact.authorAgentId;
    const updaterUserId = updaterAgentId ? null : (latestVersion?.publisherUserId ?? null);
    let updatedBy: PinnedArtifactActor | null = null;
    if (updaterAgentId || updaterUserId) {
      const { names, faces } = await actorDirectory(this.db, input.workspaceId, {
        agentIds: updaterAgentId ? [updaterAgentId] : [],
        userIds: updaterUserId ? [updaterUserId] : [],
      });
      if (updaterAgentId) {
        const name = names.get(updaterAgentId);
        if (name) {
          updatedBy = {
            kind: "agent",
            id: updaterAgentId,
            name,
            avatarUrl: faces.get(updaterAgentId),
          };
        }
      } else if (updaterUserId) {
        const name = names.get(updaterUserId);
        if (name) {
          updatedBy = {
            kind: "user",
            id: updaterUserId,
            name,
            avatarUrl: faces.get(updaterUserId),
          };
        }
      }
    }

    return {
      artifactId: artifact.id,
      title: artifact.title,
      entryPath: artifact.entryPath,
      entryKind: artifactKindOfPath(artifact.entryPath),
      version: artifact.currentVersion,
      note: latestVersion?.note?.trim() ?? "",
      preview: artifact.preview,
      updatedAt: (latestVersion?.createdAt ?? artifact.updatedAt).toISOString(),
      updatedBy,
      seen: (viewerPosition?.seenVersion ?? 0) >= artifact.currentVersion,
    };
  }
}
