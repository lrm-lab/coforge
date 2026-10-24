import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import {
  FOUNDATION_MODELS_WEEKLY_SECTIONS,
  FOUNDATION_MODELS_WEEKLY_TEMPLATE_NAME,
} from "#src/features/records/foundation-models-weekly";
import {
  appNotificationsPossible,
  attemptAppNotification,
  recordAppNotifications,
} from "#src/server/app-notifications/app-notifications.server";
import { channelMemberEvents } from "#src/server/app-notifications/channel-events.server";
import { recordWorkspaceConfigUpdated } from "#src/server/app-notifications/workspace-events.server";
import { generalChannelForCreator } from "#src/server/conversations/general-channel.server";
import { inTransaction, type DatabaseScope } from "#src/server/db/transaction.server";

/**
 * A slug another Workspace has or had. It carries Prisma's unique-violation code, so callers answer
 * it through `isUniqueViolation` exactly as they answer a clash on `workspaces.slug` itself.
 */
class WorkspaceSlugTakenError extends Error {
  readonly code = "P2002";
  constructor() {
    super("workspace slug taken");
  }
}

/**
 * Serializes every write that gives a Workspace a slug or moves it off one. A slug is unique across
 * two tables (current and former slugs), which no single index covers, so a creation and a move
 * that name the same slug take its lock first. Locks are taken in sorted order: no deadlock.
 */
async function lockSlugs(tx: Prisma.TransactionClient, slugs: string[]): Promise<void> {
  for (const slug of [...new Set(slugs)].sort())
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`workspace-slug:${slug}`}, 0))::text`;
}

/** The row a brand-new Workspace writes: owner membership, `#general`, and the default weekly
 * template. */
export function ownedWorkspaceCreateData(input: { slug: string; name: string; userId: string }) {
  return {
    slug: input.slug,
    name: input.name,
    members: { create: { userId: input.userId, role: "owner" as const } },
    conversations: generalChannelForCreator(input.userId),
    weeklyTemplates: {
      create: {
        ownerId: input.userId,
        name: FOUNDATION_MODELS_WEEKLY_TEMPLATE_NAME,
        frequency: "weekly",
        sendTime: "15:00",
        sendWeekday: 5,
        scheduleEnabled: false,
        applied: false,
        allMembers: true,
        mainTitles: [],
        dimensions: FOUNDATION_MODELS_WEEKLY_SECTIONS,
      },
    },
  };
}

/** Tells apps the new Workspace's `#general` exists, with its creator in it. The channel's id is
 * the emitter's own query, so it runs only where apps can be told, in a savepoint. */
async function recordGeneralChannelCreated(
  tx: Prisma.TransactionClient,
  input: { slug: string; userId: string },
) {
  if (!appNotificationsPossible()) return;
  const general = await attemptAppNotification(tx, () =>
    tx.conversation.findFirst({
      where: { channelName: "general", workspace: { slug: input.slug } },
      select: { id: true, workspaceId: true },
    }),
  );
  if (!general) return;
  await recordAppNotifications(tx, { id: general.workspaceId, slug: input.slug }, [
    { type: "workspace.public_channel_created", data: { channel_id: general.id, name: "general" } },
    ...channelMemberEvents("channel.member_added", [general.id], { userId: input.userId }),
  ]);
}

/** Creates a Workspace owned by `userId`, with its `#general` and the Foundation Models Weekly
 * template, unless another Workspace had `slug` before. */
export function createOwnedWorkspace<S extends Prisma.WorkspaceSelect>(
  db: DatabaseScope,
  input: { slug: string; name: string; userId: string },
  select: S,
) {
  return inTransaction(db, async (tx) => {
    await lockSlugs(tx, [input.slug]);
    if (await tx.workspaceFormerSlug.findUnique({ where: { slug: input.slug } }))
      throw new WorkspaceSlugTakenError();
    // A caller may already own a transaction. Refuse under the slug lock before INSERT, so a
    // handled collision does not abort that caller's transaction before its fallback slug.
    if (await tx.workspace.findUnique({ where: { slug: input.slug }, select: { id: true } }))
      throw new WorkspaceSlugTakenError();
    const created = await tx.workspace.create({
      data: ownedWorkspaceCreateData(input),
      select,
    });
    await recordGeneralChannelCreated(tx, input);
    return created;
  });
}

/**
 * Moves the Workspace to `slug` and keeps its current slug as a former one. Going back to one of its
 * own former slugs is allowed; one any other Workspace has or had is not. Keeping the same slug
 * changes nothing.
 */
export function moveWorkspaceSlug<S extends Prisma.WorkspaceSelect>(
  db: PrismaClient,
  workspaceId: string,
  slug: string,
  select: S,
) {
  return db.$transaction(async (tx) => {
    // The row lock keeps a second move of this Workspace from reading the same current slug;
    // the slug locks then order this move against creations naming either slug.
    const [row] = await tx.$queryRaw<{ slug: string }[]>`
      SELECT slug FROM workspaces WHERE id = ${workspaceId}::uuid FOR UPDATE`;
    if (!row) throw new Error("workspace not found");
    const current = row.slug;
    await lockSlugs(tx, [current, slug]);
    if (current !== slug) {
      const former = await tx.workspaceFormerSlug.findUnique({ where: { slug } });
      if (former && former.workspaceId !== workspaceId) throw new WorkspaceSlugTakenError();
      if (former) await tx.workspaceFormerSlug.delete({ where: { id: former.id } });
      await tx.workspaceFormerSlug.create({ data: { workspaceId, slug: current } });
    }
    const moved = await tx.workspace.update({ where: { id: workspaceId }, data: { slug }, select });
    if (current !== slug)
      await recordWorkspaceConfigUpdated(tx, { id: workspaceId, slug }, { slug });
    return moved;
  });
}

/** Whether no Workspace has or had `slug`. Only a hint for a form: the create still decides. */
export async function isWorkspaceSlugFree(db: PrismaClient, slug: string): Promise<boolean> {
  const [current, former] = await Promise.all([
    db.workspace.findUnique({ where: { slug }, select: { id: true } }),
    db.workspaceFormerSlug.findUnique({ where: { slug }, select: { id: true } }),
  ]);
  return !current && !former;
}
