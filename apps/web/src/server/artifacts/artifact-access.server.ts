import type { PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import { isWorkspaceAdminRole } from "#src/features/workspaces/workspace-roles";
import {
  actorConversationAccess,
  actorConversationHomeReads,
  agentsConversationHomeReads,
  canReadConversationHome,
  conversationHiddenFromWorkspace,
  type ActorConversationHomeRead,
} from "#src/server/conversations/channel-read-access.server";
import { PrismaExperimentsRepository } from "#src/server/experiments/experiments.repositories.server";
import { Experiments } from "#src/server/experiments/experiments.server";
import { isFeatureEnabled } from "#src/server/feature-flags/feature-flags.server";

export type ArtifactActor =
  | { userId: string; agentId?: undefined }
  | { agentId: string; userId?: undefined };

export type ArtifactPublisher = Extract<ArtifactActor, { agentId: string }>;

export type ArtifactHomeKind = "channel" | "dm" | "workspace";

export type ArtifactHomeAccess = { read: boolean; write: boolean; homeKind: ArtifactHomeKind };

export type ArtifactTier = "conversation" | "workspace";

export type ArtifactAccessRow = {
  homeKey: string;
  access: string;
  authorAgentId: string | null;
};

export type ArtifactHomeView = {
  tier: ArtifactTier;
  homeKey: string | null;
  homeKind: ArtifactHomeKind;
};

type Db = Pick<PrismaClient, "workspaceMembership" | "agent" | "conversation">;

export function artifactHomeConversationId(homeKey: string): string | undefined {
  if (!homeKey.startsWith("conversation:")) return undefined;
  const conversationId = homeKey.slice("conversation:".length);
  return UUID.test(conversationId) ? conversationId : undefined;
}

export type ArtifactViewer = { member: boolean; role: string | null };

export async function artifactViewer(
  db: Db,
  workspaceId: string,
  actor: ArtifactActor,
): Promise<ArtifactViewer> {
  if (actor.userId) {
    const membership = await db.workspaceMembership.findUnique({
      where: { workspaceId_userId: { workspaceId, userId: actor.userId } },
      select: { role: true },
    });
    return { member: membership !== null, role: membership?.role ?? null };
  }
  const agent = await db.agent.findFirst({
    where: { id: actor.agentId, workspaceId, deletedAt: null },
    select: { id: true },
  });
  return { member: agent !== null, role: null };
}

export function artifactTier(
  artifact: Pick<ArtifactAccessRow, "homeKey" | "access">,
): ArtifactTier {
  return artifact.access === "workspace" || artifact.homeKey === "workspace"
    ? "workspace"
    : "conversation";
}

export async function conversationHomeAccess(
  db: Db,
  workspaceId: string,
  actor: ArtifactActor,
  conversationId: string,
  viewer?: ArtifactViewer,
): Promise<ArtifactHomeAccess> {
  const none = { read: false, write: false, homeKind: "workspace" } as const;
  const member = viewer === undefined ? await inWorkspace(db, workspaceId, actor) : viewer.member;
  if (!member) return none;
  const access = await actorConversationAccess(db, workspaceId, actor, conversationId);
  if (!access) return none;
  return { read: access.read, write: access.write, homeKind: access.kind };
}

export async function requireConversationHome(
  db: Db,
  workspaceId: string,
  actor: ArtifactActor,
  conversationId: string,
  need: "read" | "write",
  viewer?: ArtifactViewer,
): Promise<ArtifactHomeAccess> {
  const access = await conversationHomeAccess(db, workspaceId, actor, conversationId, viewer);
  if (!access.read) throw new AppError("NOT_FOUND");
  if (need === "write" && !access.write) throw new AppError("ACCESS_DENIED");
  return access;
}

export function homeStands(home: ActorConversationHomeRead | undefined) {
  return home !== undefined && !home.hidden;
}

export function artifactHomeView(
  artifact: Pick<ArtifactAccessRow, "homeKey" | "access">,
  home: ActorConversationHomeRead | undefined,
): ArtifactHomeView {
  if (artifactTier(artifact) === "workspace") {
    const named =
      home !== undefined &&
      homeStands(home) &&
      canReadConversationHome(home) &&
      artifactHomeConversationId(artifact.homeKey) !== undefined;
    return named
      ? { tier: "workspace", homeKey: artifact.homeKey, homeKind: home.kind }
      : { tier: "workspace", homeKey: "workspace", homeKind: "workspace" };
  }
  if (home === undefined) return { tier: "conversation", homeKey: null, homeKind: "workspace" };
  return { tier: "conversation", homeKey: artifact.homeKey, homeKind: home.kind };
}

export function readsArtifactOfGoneHome(
  actor: ArtifactActor,
  viewer: ArtifactViewer,
  artifact: Pick<ArtifactAccessRow, "authorAgentId">,
  authorAgentOwnerId: string | null,
): boolean {
  if (actor.agentId !== undefined) return artifact.authorAgentId === actor.agentId;
  return isWorkspaceAdminRole(viewer.role ?? undefined) || authorAgentOwnerId === actor.userId;
}

export function artifactReadableFromHome(input: {
  actor: ArtifactActor;
  viewer: ArtifactViewer;
  artifact: ArtifactAccessRow;
  home: ActorConversationHomeRead | undefined;
  authorAgentOwnerId: string | null;
}): boolean {
  const { actor, viewer, artifact, home, authorAgentOwnerId } = input;
  if (!viewer.member) return false;
  if (artifactTier(artifact) === "workspace") return true;
  if (home !== undefined && homeStands(home)) return canReadConversationHome(home);
  return readsArtifactOfGoneHome(actor, viewer, artifact, authorAgentOwnerId);
}

export async function agentsReadingArtifact(
  db: Pick<PrismaClient, "conversation">,
  workspaceId: string,
  artifact: ArtifactAccessRow,
  workspaceAgentIds: readonly string[],
): Promise<Set<string>> {
  if (artifactTier(artifact) === "workspace" || workspaceAgentIds.length === 0)
    return new Set(workspaceAgentIds);
  const conversationId = artifactHomeConversationId(artifact.homeKey);
  const homes = conversationId
    ? await agentsConversationHomeReads(db, workspaceId, conversationId, workspaceAgentIds)
    : undefined;
  return new Set(
    workspaceAgentIds.filter((agentId) =>
      artifactReadableFromHome({
        actor: { agentId },
        viewer: { member: true, role: null },
        artifact,
        home: homes?.get(agentId),
        authorAgentOwnerId: null,
      }),
    ),
  );
}

export async function artifactAuthorOwnerId(
  db: Pick<PrismaClient, "agent">,
  authorAgentId: string | null,
): Promise<string | null> {
  if (!authorAgentId) return null;
  const author = await db.agent.findFirst({
    where: { id: authorAgentId },
    select: { ownerId: true },
  });
  return author?.ownerId ?? null;
}

export async function artifactReadView(
  db: Db,
  workspaceId: string,
  actor: ArtifactActor,
  artifact: ArtifactAccessRow,
  options: { viewer?: ArtifactViewer; authorAgentOwnerId?: string | null } = {},
): Promise<ArtifactHomeView | null> {
  const viewer = options.viewer ?? (await artifactViewer(db, workspaceId, actor));
  if (!viewer.member) return null;
  const wide = artifactTier(artifact) === "workspace";
  const conversationId = artifactHomeConversationId(artifact.homeKey);
  const home = conversationId
    ? (await actorConversationHomeReads(db, workspaceId, actor, [conversationId])).get(
        conversationId,
      )
    : undefined;
  const ownerMatters =
    !wide &&
    !homeStands(home) &&
    actor.userId !== undefined &&
    !isWorkspaceAdminRole(viewer.role ?? undefined);
  const authorAgentOwnerId =
    options.authorAgentOwnerId !== undefined
      ? options.authorAgentOwnerId
      : ownerMatters
        ? await artifactAuthorOwnerId(db, artifact.authorAgentId)
        : null;
  if (!artifactReadableFromHome({ actor, viewer, artifact, home, authorAgentOwnerId })) return null;
  return artifactHomeView(artifact, home);
}

export async function requireArtifactRead(
  db: Db,
  workspaceId: string,
  actor: ArtifactActor,
  artifact: ArtifactAccessRow,
  options: { viewer?: ArtifactViewer; authorAgentOwnerId?: string | null } = {},
): Promise<ArtifactHomeView> {
  const view = await artifactReadView(db, workspaceId, actor, artifact, options);
  if (!view) throw new AppError("NOT_FOUND");
  return view;
}

export async function artifactHomeHidden(
  db: Db,
  workspaceId: string,
  artifact: Pick<ArtifactAccessRow, "homeKey" | "access">,
): Promise<boolean> {
  if (artifactTier(artifact) === "workspace") return false;
  const conversationId = artifactHomeConversationId(artifact.homeKey);
  if (!conversationId) return false;
  return conversationHiddenFromWorkspace(db, workspaceId, conversationId);
}

export async function canManageArtifactSharing(
  db: Pick<PrismaClient, "workspaceMembership">,
  workspaceId: string,
  actor: ArtifactActor,
  artifact: { authorAgentOwnerId: string | null },
): Promise<boolean> {
  const role = actor.userId
    ? (
        await db.workspaceMembership.findUnique({
          where: { workspaceId_userId: { workspaceId, userId: actor.userId } },
          select: { role: true },
        })
      )?.role
    : undefined;
  return canManageArtifactSharingWithRole(actor, role, artifact);
}

export function canManageArtifactSharingWithRole(
  actor: ArtifactActor,
  role: string | null | undefined,
  artifact: { authorAgentOwnerId: string | null },
): boolean {
  return (
    actor.userId !== undefined &&
    (artifact.authorAgentOwnerId === actor.userId || isWorkspaceAdminRole(role ?? undefined))
  );
}

/** Whether the actor belongs to the Workspace: a member person, or one of its live Agents. */
export async function inWorkspace(db: Db, workspaceId: string, actor: ArtifactActor) {
  if (actor.userId)
    return (
      (await db.workspaceMembership.findUnique({
        where: { workspaceId_userId: { workspaceId, userId: actor.userId } },
        select: { userId: true },
      })) !== null
    );
  return (
    (await db.agent.findFirst({
      where: { id: actor.agentId, workspaceId, deletedAt: null },
      select: { id: true },
    })) !== null
  );
}

export async function canDeleteArtifact(
  db: Pick<PrismaClient, "workspaceMembership" | "agent">,
  workspaceId: string,
  actor: ArtifactActor,
  artifact: { authorAgentId: string | null },
): Promise<boolean> {
  if (actor.userId === undefined) return artifact.authorAgentId === actor.agentId;
  const membership = await db.workspaceMembership.findUnique({
    where: { workspaceId_userId: { workspaceId, userId: actor.userId } },
    select: { role: true },
  });
  if (isWorkspaceAdminRole(membership?.role)) return true;
  if (!artifact.authorAgentId) return false;
  const author = await db.agent.findFirst({
    where: { id: artifact.authorAgentId, workspaceId },
    select: { ownerId: true },
  });
  return author?.ownerId === actor.userId;
}

export function canDeleteArtifactWithRole(
  actor: ArtifactActor,
  role: string | null,
  artifact: { authorAgentId: string | null },
): boolean {
  if (actor.userId === undefined) return artifact.authorAgentId === actor.agentId;
  return isWorkspaceAdminRole(role ?? undefined);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const artifactsDisabled = () =>
  new AppError("ACCESS_DENIED", {
    errorId: "artifacts-disabled",
    hint: "this Workspace has not enabled documents (Settings > Experiments, switched on by a Workspace owner or admin)",
  });

export async function artifactsEnabled(db: PrismaClient, workspaceId: string): Promise<boolean> {
  const workspace = await db.workspace.findUnique({
    where: { id: workspaceId },
    select: { slug: true },
  });
  if (!workspace) return false;
  return new Experiments(new PrismaExperimentsRepository(db), isFeatureEnabled).enabled(
    "artifacts",
    { workspaceId, workspaceSlug: workspace.slug },
  );
}
