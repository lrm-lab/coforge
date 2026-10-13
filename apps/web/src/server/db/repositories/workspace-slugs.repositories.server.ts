import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import { generalChannelForCreator } from "#src/server/conversations/public-channels.server";

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

/** Creates a Workspace owned by `userId`, with its `#general`, unless another Workspace had `slug`
 * before. */
export function createOwnedWorkspace<S extends Prisma.WorkspaceSelect>(
  db: PrismaClient,
  input: { slug: string; name: string; userId: string },
  select: S,
) {
  return db.$transaction(async (tx) => {
    await lockSlugs(tx, [input.slug]);
    if (await tx.workspaceFormerSlug.findUnique({ where: { slug: input.slug } }))
      throw new WorkspaceSlugTakenError();
    return tx.workspace.create({
      data: {
        slug: input.slug,
        name: input.name,
        members: { create: { userId: input.userId, role: "owner" } },
        conversations: generalChannelForCreator(input.userId),
      },
      select,
    });
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
    return tx.workspace.update({ where: { id: workspaceId }, data: { slug }, select });
  });
}
