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

/** Which kind of home an artifact lives in: a channel, a DM, or the Workspace. The web page
 * builds a document's link from this (a channel and a DM route differently). */
export type ArtifactHomeKind = "channel" | "dm" | "workspace";

/** What an actor may do with an artifact's home: read it, write (create and save) in it, and
 * which kind of home it is. */
export type ArtifactHomeAccess = { read: boolean; write: boolean; homeKind: ArtifactHomeKind };

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
  // The home's kind is known from its key alone, except channel vs DM, which the conversation's
  // `channelName` below settles. A tier-only reader still hears the kind (task #529); it never
  // hears the home's id.
  const homeKind: ArtifactHomeKind = homeKey === "workspace" ? "workspace" : "dm";
  const none = { read: false, write: false, homeKind };
  if (!(await inWorkspace(db, workspaceId, actor))) return none;
  if (homeKey === "workspace") return { read: true, write: true, homeKind: "workspace" };
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
  return {
    read,
    write: member && conversation.archivedAt === null,
    homeKind: conversation.channelName === null ? "dm" : "channel",
  };
}

/** The read tier an artifact carries (task #529): `conversation` keeps reads to its home
 * conversation's readers; `workspace` widens reads to every Workspace member. Writes never
 * follow the tier — a workspace-shared artifact stays written only by its home's writers.
 * A workspace-home artifact's tier is always `workspace`. */
export type ArtifactAccessTier = "conversation" | "workspace";

/** Whether the actor may read one artifact (task #529): its home's readers, or any Workspace
 * member — people and Agents alike — when the artifact's tier is `workspace`. */
export async function artifactReadAccess(
  db: Db,
  workspaceId: string,
  actor: ArtifactActor,
  artifact: { homeKey: string; access: string },
): Promise<boolean> {
  const access = await artifactHomeAccess(db, workspaceId, actor, artifact.homeKey);
  return (
    access.read || (artifact.access === "workspace" && (await inWorkspace(db, workspaceId, actor)))
  );
}

/**
 * The actor's read of one artifact (task #529): its home's rule, or any Workspace member when
 * the artifact's tier is `workspace`. Answers the home's kind either way, for link building,
 * and `homeRead` — whether the home's own rule granted the read — so a tier-only reader never
 * sees the home's key (a private conversation's id is not theirs to know).
 */
export async function requireArtifactRead(
  db: Db,
  workspaceId: string,
  actor: ArtifactActor,
  artifact: { homeKey: string; access: string },
): Promise<ArtifactHomeAccess & { homeRead: boolean }> {
  const access = await artifactHomeAccess(db, workspaceId, actor, artifact.homeKey);
  if (access.read) return { ...access, homeRead: true };
  if (artifact.access === "workspace" && (await inWorkspace(db, workspaceId, actor)))
    return { ...access, read: true, homeRead: false };
  throw new AppError("NOT_FOUND");
}

/** Whether the actor may change an artifact's read tier (task #529): a person who authored it,
 * the owner of the Agent that did, or a Workspace owner or admin. An Agent never may. The
 * authoring Agent's `ownerId` comes with the artifact row, so a missing Agent means it was
 * deleted — no special case. */
export async function canChangeArtifactAccess(
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
  return canChangeArtifactAccessWithRole(actor, role, artifact);
}

/** The `canChangeArtifactAccess` rule with the actor's Workspace role already in hand, for one
 * role shared by a list of cards. */
export function canChangeArtifactAccessWithRole(
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
 * Moves the artifact between read tiers (task #529), recording who moved it, from which tier to
 * which, and when — a change is not a version, so content history stays versions only, and the
 * artifact's `updatedAt` is left alone (content did not change). A workspace-home artifact has
 * only the `workspace` tier. The decision and the event are made under one row lock, as `push`
 * serializes versions: a concurrent change cannot slip between the read and the write. Refusals:
 * the artifact is missing or unreadable, `NOT_FOUND`; a workspace home asked for `conversation`,
 * `INVALID_INPUT`; a reader who may not change, `ACCESS_DENIED`.
 */
export async function changeArtifactAccess(
  db: Db & Pick<PrismaClient, "artifactAccessEvent" | "$transaction" | "$queryRaw" | "$executeRaw">,
  workspaceId: string,
  actor: ArtifactActor,
  input: { artifactId: string; access: ArtifactAccessTier },
): Promise<void> {
  if (input.access === "conversation") {
    const [home] = await db.$queryRaw<{ homeKey: string }[]>`SELECT "homeKey" FROM "artifacts"
        WHERE "id" = ${input.artifactId}::uuid AND "workspaceId" = ${workspaceId}::uuid
          AND "deletedAt" IS NULL`;
    if (home?.homeKey === "workspace")
      throw new AppError("INVALID_INPUT", {
        errorId: "artifact-access-tier",
        hint: "a Workspace artifact has only the workspace tier",
      });
  }
  await db.$transaction(async (tx) => {
    const [artifact] = await tx.$queryRaw<
      {
        id: string;
        homeKey: string;
        access: string;
        authorUserId: string | null;
        authorAgentId: string | null;
      }[]
    >`SELECT "id", "homeKey", "access", "authorUserId", "authorAgentId"
        FROM "artifacts"
        WHERE "id" = ${input.artifactId}::uuid AND "workspaceId" = ${workspaceId}::uuid
          AND "deletedAt" IS NULL
        FOR UPDATE`;
    if (!artifact) throw new AppError("NOT_FOUND");
    if (!(await artifactReadAccess(tx, workspaceId, actor, artifact)))
      throw new AppError("NOT_FOUND");
    const ownerId = artifact.authorAgentId
      ? (
          await tx.agent.findFirst({
            where: { id: artifact.authorAgentId },
            select: { ownerId: true },
          })
        )?.ownerId
      : undefined;
    if (
      !(await canChangeArtifactAccess(tx, workspaceId, actor, {
        authorUserId: artifact.authorUserId,
        authorAgentId: artifact.authorAgentId,
        authorAgentOwnerId: ownerId ?? null,
      }))
    )
      throw new AppError("ACCESS_DENIED");
    if (artifact.access === input.access) return;
    // Raw so the content's `updatedAt` stands: an access change is not a content change.
    await tx.$executeRaw`UPDATE "artifacts" SET "access" = ${input.access} WHERE "id" = ${artifact.id}::uuid`;
    await tx.artifactAccessEvent.create({
      data: {
        artifactId: artifact.id,
        from: artifact.access,
        to: input.access,
        ...(actor.agentId ? { actorAgentId: actor.agentId } : { actorUserId: actor.userId }),
      },
    });
  });
}

/**
 * The actor's write of one artifact (task #529): writes never follow the tier, so the home's
 * rule decides (`need` is `read` where the operation only requires reading the home, as a
 * delete does, and `write` where it requires writing it, as a save does). A reader who reaches
 * the artifact only through the widened tier hears `ACCESS_DENIED` — it knows the artifact is
 * there — while anyone who cannot read it at all hears `NOT_FOUND`, as if it were not.
 */
export async function requireArtifactWrite(
  db: Db,
  workspaceId: string,
  actor: ArtifactActor,
  artifact: { homeKey: string; access: string },
  need: "read" | "write",
): Promise<ArtifactHomeAccess> {
  const access = await artifactHomeAccess(db, workspaceId, actor, artifact.homeKey);
  if (need === "write" ? access.write : access.read) return access;
  if (await artifactReadAccess(db, workspaceId, actor, artifact))
    throw new AppError("ACCESS_DENIED");
  throw new AppError("NOT_FOUND");
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
