import type { PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import { isWorkspaceAdminRole } from "#src/features/workspaces/workspace-roles";
import {
  actorConversationAccess,
  conversationHiddenFromWorkspace,
} from "#src/server/conversations/channel-read-access.server";
import { PrismaExperimentsRepository } from "#src/server/experiments/experiments.repositories.server";
import { Experiments } from "#src/server/experiments/experiments.server";
import { isFeatureEnabled } from "#src/server/feature-flags/feature-flags.server";

/** A person or an Agent of the Workspace, acting on an artifact. */
export type ArtifactActor =
  | { userId: string; agentId?: undefined }
  | { agentId: string; userId?: undefined };

/** Which kind of home an artifact lives in: a channel, a DM, or the Workspace. The web page
 * builds a document's link from this (a channel and a DM route differently). */
export type ArtifactHomeKind = "channel" | "dm" | "workspace";

/** What an actor may do with an artifact's home: read it, write (create and save) in it, and
 * which kind of home it is. */
export type ArtifactHomeAccess = { read: boolean; write: boolean; homeKind: ArtifactHomeKind };

type Db = Pick<PrismaClient, "workspaceMembership" | "agent" | "conversation">;

/** The conversation id a `conversation:<id>` home key names, or undefined for the Workspace
 * home, any other key, or an id that is not a UUID (which no query may take). */
export function artifactHomeConversationId(homeKey: string): string | undefined {
  if (!homeKey.startsWith("conversation:")) return undefined;
  const conversationId = homeKey.slice("conversation:".length);
  return UUID.test(conversationId) ? conversationId : undefined;
}

/**
 * An artifact's home is its write rule and its privacy boundary (task #385; reads widened
 * workspace-wide in task #20). A conversation's artifact is written by its active members,
 * people and Agents alike, while it is not archived, and a Workspace role grants nothing
 * there; a Workspace artifact is every member's to write. Only a channel or a DM is a
 * conversation home; a public home is not offered yet.
 */
export async function artifactHomeAccess(
  db: Db,
  workspaceId: string,
  actor: ArtifactActor,
  homeKey: string,
): Promise<ArtifactHomeAccess> {
  // The home's kind is known from its key alone, except channel vs DM, which the conversation's
  // `channelName` below settles. A workspace-only reader still hears the kind (task #20); it
  // never hears the home's id.
  const homeKind: ArtifactHomeKind = homeKey === "workspace" ? "workspace" : "dm";
  const none = { read: false, write: false, homeKind };
  if (!(await inWorkspace(db, workspaceId, actor))) return none;
  if (homeKey === "workspace") return { read: true, write: true, homeKind: "workspace" };
  const conversationId = artifactHomeConversationId(homeKey);
  if (!conversationId) return none;
  // The conversation's own read/write rule lives in `server/conversations` (task #542): the
  // artifacts module asks the port, never the conversation tables.
  const access = await actorConversationAccess(db, workspaceId, actor, conversationId);
  if (!access) return none;
  return { read: access.read, write: access.write, homeKind: access.kind };
}

/**
 * The actor's read of one artifact (task #20): every Workspace member — people and Agents
 * alike — reads every artifact, including one whose home they cannot read; `homeRead` says
 * whether the home's own rule granted the read, so a member who reaches the artifact only
 * workspace-wide never sees the home's key (a private conversation's id is not theirs to
 * know). Writes never follow the read: they stay the home's.
 */
export async function requireArtifactRead(
  db: Db,
  workspaceId: string,
  actor: ArtifactActor,
  artifact: { homeKey: string },
): Promise<ArtifactHomeAccess & { homeRead: boolean }> {
  const access = await artifactHomeAccess(db, workspaceId, actor, artifact.homeKey);
  if (access.read) return { ...access, homeRead: true };
  if (!(await inWorkspace(db, workspaceId, actor))) throw new AppError("NOT_FOUND");
  // A home the Workspace hides is gone for everyone, its artifacts with it.
  if (await artifactHomeHidden(db, workspaceId, artifact.homeKey)) throw new AppError("NOT_FOUND");
  return { ...access, read: true, homeRead: false };
}

/** Whether the actor may manage an artifact's public link (task #20): a person who authored
 * it, the owner of the Agent that did, or a Workspace owner or admin. An Agent never may. The
 * authoring Agent's `ownerId` comes with the artifact row, so a missing Agent means it was
 * deleted — no special case. */
export async function canManageArtifactPublicLink(
  db: Pick<PrismaClient, "workspaceMembership">,
  workspaceId: string,
  actor: ArtifactActor,
  artifact: {
    authorUserId: string | null;
    authorAgentId: string | null;
    authorAgentOwnerId: string | null;
  },
): Promise<boolean> {
  const role = actor.userId
    ? (
        await db.workspaceMembership.findUnique({
          where: { workspaceId_userId: { workspaceId, userId: actor.userId } },
          select: { role: true },
        })
      )?.role
    : undefined;
  return canManageArtifactPublicLinkWithRole(actor, role, artifact);
}

/** The `canManageArtifactPublicLink` rule with the actor's Workspace role already in hand, for
 * one role shared by a list of cards. */
export function canManageArtifactPublicLinkWithRole(
  actor: ArtifactActor,
  role: string | null | undefined,
  artifact: {
    authorUserId: string | null;
    authorAgentId: string | null;
    authorAgentOwnerId: string | null;
  },
): boolean {
  return (
    actor.userId !== undefined &&
    (artifact.authorUserId === actor.userId ||
      artifact.authorAgentOwnerId === actor.userId ||
      isWorkspaceAdminRole(role ?? undefined))
  );
}

/**
 * The actor's write of one artifact: writes never follow the read, so the home's rule decides
 * (`need` is `read` where the operation only requires reading the home, as a delete does, and
 * `write` where it requires writing it, as a save does). Every member reads, so a member the
 * home keeps out hears `ACCESS_DENIED` — it knows the artifact is there — while anyone who is
 * no member at all hears `NOT_FOUND`, as if it were not.
 */
export async function requireArtifactWrite(
  db: Db,
  workspaceId: string,
  actor: ArtifactActor,
  artifact: { homeKey: string },
  need: "read" | "write",
): Promise<ArtifactHomeAccess> {
  const access = await artifactHomeAccess(db, workspaceId, actor, artifact.homeKey);
  if (need === "write" ? access.write : access.read) return access;
  if (!(await inWorkspace(db, workspaceId, actor))) throw new AppError("NOT_FOUND");
  if (await artifactHomeHidden(db, workspaceId, artifact.homeKey)) throw new AppError("NOT_FOUND");
  throw new AppError("ACCESS_DENIED");
}

/** Whether the artifact's home is a conversation the Workspace hides: such a home is gone for
 * everyone, so its artifacts answer `NOT_FOUND` even to members who would otherwise read or
 * write them workspace-wide. Looked up only after the home's own rule refused the actor, so the
 * common path pays nothing. */
export async function artifactHomeHidden(
  db: Db,
  workspaceId: string,
  homeKey: string,
): Promise<boolean> {
  const conversationId = artifactHomeConversationId(homeKey);
  if (!conversationId) return false;
  return conversationHiddenFromWorkspace(db, workspaceId, conversationId);
}

/** The actor's access to a home, required: `NOT_FOUND` where it cannot read, as if nothing were
 * there, and `ACCESS_DENIED` where it reads but may not write. */
export async function requireArtifactHome(
  db: Db,
  workspaceId: string,
  actor: ArtifactActor,
  homeKey: string,
  need: "read" | "write",
): Promise<ArtifactHomeAccess> {
  const access = await artifactHomeAccess(db, workspaceId, actor, homeKey);
  if (!access.read) throw new AppError("NOT_FOUND");
  if (need === "write" && !access.write) throw new AppError("ACCESS_DENIED");
  return access;
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

/** Whether the actor deletes an artifact it can read: its author, or a Workspace owner or admin
 * (a person); an Agent only its own. */
export async function canDeleteArtifact(
  db: Pick<PrismaClient, "workspaceMembership">,
  workspaceId: string,
  actor: ArtifactActor,
  artifact: { authorUserId: string | null; authorAgentId: string | null },
): Promise<boolean> {
  if (actor.userId === undefined) return artifact.authorAgentId === actor.agentId;
  if (artifact.authorUserId === actor.userId) return true;
  const membership = await db.workspaceMembership.findUnique({
    where: { workspaceId_userId: { workspaceId, userId: actor.userId } },
    select: { role: true },
  });
  return isWorkspaceAdminRole(membership?.role);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The refusal of every artifact operation in a Workspace that has not switched them on. */
export const artifactsDisabled = () =>
  new AppError("ACCESS_DENIED", {
    errorId: "artifacts-disabled",
    hint: "this Workspace has not enabled documents (Settings > Experiments, switched on by a Workspace owner or admin)",
  });

/** Whether the Workspace has the `artifacts` experiment on: its flag offers it, and an owner or
 * admin switched it on. */
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
