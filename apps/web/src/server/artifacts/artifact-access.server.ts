import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import { isWorkspaceAdminRole } from "#src/features/workspaces/workspace-roles";
import {
  ACTIVE_MEMBER_WHERE,
  DIRECT_CONVERSATION_WHERE,
  VISIBLE_CONVERSATION_WHERE,
} from "#src/server/conversations/active-member.server";
import { canReadChannel } from "#src/server/conversations/channel-read-access.server";
import { PrismaExperimentsRepository } from "#src/server/experiments/experiments.repositories.server";
import { Experiments } from "#src/server/experiments/experiments.server";
import { isFeatureEnabled } from "#src/server/feature-flags/feature-flags.server";

/** A person or an Agent of the Workspace, acting on an artifact. */
export type ArtifactActor =
  | { userId: string; agentId?: undefined }
  | { agentId: string; userId?: undefined };

/** What an actor may do with an artifact's home: read it, and write (create and save) in it. */
export type ArtifactHomeAccess = { read: boolean; write: boolean };

type Db = Pick<PrismaClient, "workspaceMembership" | "agent" | "conversation">;

/**
 * An artifact's home is its only access rule (task #385). A conversation's artifact is read by
 * whoever reads the conversation (a public channel by everyone of the Workspace, a private
 * channel and a DM by their active members; a Workspace role grants nothing there) and written by
 * its active members, people and Agents alike, while it is not archived. A Workspace artifact is every member's to read and
 * write. Only a channel or a DM is a conversation home; a public home is not offered yet.
 */
export async function artifactHomeAccess(
  db: Db,
  workspaceId: string,
  actor: ArtifactActor,
  homeKey: string,
): Promise<ArtifactHomeAccess> {
  const none = { read: false, write: false };
  if (!(await inWorkspace(db, workspaceId, actor))) return none;
  if (homeKey === "workspace") return { read: true, write: true };
  const conversationId = homeKey.startsWith("conversation:")
    ? homeKey.slice("conversation:".length)
    : undefined;
  if (!conversationId || !UUID.test(conversationId)) return none;
  const conversation = await db.conversation.findFirst({
    where: {
      id: conversationId,
      workspaceId,
      ...VISIBLE_CONVERSATION_WHERE,
      OR: [{ channelName: { not: null } }, DIRECT_CONVERSATION_WHERE],
    },
    select: {
      channelName: true,
      visibility: true,
      archivedAt: true,
      members: { where: { ...memberOf(actor), ...ACTIVE_MEMBER_WHERE }, select: { id: true } },
    },
  });
  if (!conversation) return none;
  const member = conversation.members.length > 0;
  const read = conversation.channelName === null ? member : canReadChannel(conversation, member);
  // An archived channel is read only, as it is for messages (`channel-send` refuses it).
  return { read, write: member && conversation.archivedAt === null };
}

/** The actor's access to a home, required: `NOT_FOUND` where it cannot read, as if nothing were
 * there, and `ACCESS_DENIED` where it reads but may not write. */
export async function requireArtifactHome(
  db: Db,
  workspaceId: string,
  actor: ArtifactActor,
  homeKey: string,
  need: "read" | "write",
) {
  const access = await artifactHomeAccess(db, workspaceId, actor, homeKey);
  if (!access.read) throw new AppError("NOT_FOUND");
  if (need === "write" && !access.write) throw new AppError("ACCESS_DENIED");
}

/** Whether the actor belongs to the Workspace: a member person, or one of its live Agents. */
async function inWorkspace(db: Db, workspaceId: string, actor: ArtifactActor) {
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

const memberOf = (actor: ArtifactActor) =>
  (actor.userId
    ? { userId: actor.userId }
    : { agentId: actor.agentId }) satisfies Prisma.ConversationMemberWhereInput;

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
