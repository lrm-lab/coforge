import type { PrismaClient } from "#src/generated/prisma/client";
import { artifactPresenceChannel } from "#src/features/artifacts/artifact-presence-channel";
import { encodeArtifactShortId } from "#src/features/artifacts/artifact-short-id";
import { actorNames } from "./artifact-actor-names.server";
import { artifactHomeConversationId } from "./artifact-access.server";
import type { ArtifactOrigin } from "./artifact-reads.server";
import { artifactApplicationOrigin } from "./artifact-sandbox-config.server";

export type ArtifactPresencePort = (channel: string) => Promise<{ user: string }[]>;

type ContextDb = Pick<PrismaClient, "workspace" | "conversation" | "agent" | "user">;

export async function artifactWebUrl(
  db: Pick<PrismaClient, "workspace">,
  workspaceId: string,
  artifactId: string,
  appOrigin?: () => string | null,
): Promise<string | null> {
  const workspace = await db.workspace.findUnique({
    where: { id: workspaceId },
    select: { slug: true },
  });
  if (!workspace?.slug) return null;
  const origin = appOrigin?.() ?? artifactApplicationOrigin() ?? "";
  return `${origin}/w/${encodeURIComponent(workspace.slug)}/artifacts/${encodeArtifactShortId(artifactId)}`;
}

async function conversationTargetLabel(
  db: Pick<PrismaClient, "conversation">,
  workspaceId: string,
  conversationId: string,
): Promise<string | null> {
  const conversation = await db.conversation.findFirst({
    where: { id: conversationId, workspaceId },
    select: { channelName: true, directKey: true },
  });
  if (!conversation) return null;
  if (conversation.channelName) return `#${conversation.channelName}`;
  if (conversation.directKey) return "DM";
  return null;
}

export async function artifactReadContext(
  db: ContextDb,
  input: {
    workspaceId: string;
    artifact: {
      id: string;
      access: string;
      homeKey: string | null;
      homeKind: string;
      origin: ArtifactOrigin | null;
    };
    appOrigin?: () => string | null;
    presence?: ArtifactPresencePort;
  },
): Promise<{
  url: string | null;
  home: string;
  origin: { messageId: string; target?: string; threadRootId?: string } | null;
  viewing: string[];
}> {
  const { workspaceId, artifact } = input;
  const homeConversationId = artifact.homeKey
    ? artifactHomeConversationId(artifact.homeKey)
    : undefined;
  const originVisible = artifact.origin && !("hidden" in artifact.origin) ? artifact.origin : null;
  const originConversationId =
    originVisible && originVisible.conversationId !== homeConversationId
      ? originVisible.conversationId
      : undefined;

  const [url, homeLabel, originLabel, viewing] = await Promise.all([
    artifactWebUrl(db, workspaceId, artifact.id, input.appOrigin),
    homeConversationId ? conversationTargetLabel(db, workspaceId, homeConversationId) : null,
    originConversationId ? conversationTargetLabel(db, workspaceId, originConversationId) : null,
    viewingNow(db, workspaceId, artifact.id, input.presence),
  ]);

  const home =
    artifact.access === "link"
      ? "Workspace (anyone with the link)"
      : artifact.access === "workspace"
        ? "Workspace"
        : (homeLabel ?? artifact.homeKind);

  const originTarget = originVisible
    ? originVisible.conversationId === homeConversationId
      ? homeLabel
      : originLabel
    : null;

  const origin = originVisible
    ? {
        messageId: originVisible.messageId,
        ...(originTarget ? { target: originTarget } : {}),
        ...(originVisible.threadRootId ? { threadRootId: originVisible.threadRootId } : {}),
      }
    : null;

  return { url, home, origin, viewing };
}

async function viewingNow(
  db: Pick<PrismaClient, "agent" | "user">,
  workspaceId: string,
  artifactId: string,
  presence?: ArtifactPresencePort,
): Promise<string[]> {
  if (!presence) return [];
  let clients: { user: string }[];
  try {
    clients = await presence(artifactPresenceChannel(workspaceId, artifactId));
  } catch {
    return [];
  }
  const userIds = [...new Set(clients.map((client) => client.user).filter(Boolean))];
  if (userIds.length === 0) return [];
  const names = await actorNames(db, workspaceId, { userIds, agentIds: [] });
  return userIds.map((id) => names.get(id)).filter((name): name is string => Boolean(name));
}
