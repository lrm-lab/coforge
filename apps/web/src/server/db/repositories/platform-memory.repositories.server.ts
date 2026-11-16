import type { PrismaClient, Prisma, PlatformMemoryHead } from "#src/generated/prisma/client";
import {
  MemoryError,
  type MemoryActor,
  type MemoryHead,
  type MemoryStore,
} from "#src/server/platform-memory/contract";
import { platformMemoryEnabled } from "#src/server/platform-memory/activation.server";
import { paginated } from "#src/server/db/pagination.server";
import { isUniqueViolation } from "#src/server/db/unique-violation.server";

function head(row: PlatformMemoryHead): MemoryHead {
  if (
    (row.scope !== "agent" && row.scope !== "team") ||
    !["fact", "experience", "preference"].includes(row.kind)
  )
    throw new MemoryError("unavailable");
  return { ...row, scope: row.scope, kind: row.kind as MemoryHead["kind"] };
}
function visible(
  workspaceId: string,
  agentIds: string[],
  now: Date,
): Prisma.PlatformMemoryHeadWhereInput {
  return {
    workspaceId,
    deletedAt: null,
    revision: { gt: 0 },
    AND: [
      { OR: [{ scope: "team" }, { scope: "agent", agentId: { in: agentIds } }] },
      { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
    ],
  };
}
export class PrismaPlatformMemoryStore implements MemoryStore {
  constructor(private readonly db: PrismaClient) {}
  async access(actor: MemoryActor) {
    const agent =
      actor.kind === "agent"
        ? await this.db.agent.findFirst({
            where: { id: actor.agentId, workspaceId: actor.workspaceId, deletedAt: null },
            select: { ownerId: true },
          })
        : null;
    const userId = actor.kind === "user" ? actor.userId : agent?.ownerId;
    if (!userId) throw new MemoryError("forbidden");
    const membership = await this.db.workspaceMembership.findUnique({
      where: { workspaceId_userId: { workspaceId: actor.workspaceId, userId } },
      select: { role: true },
    });
    if (!membership) throw new MemoryError("forbidden");
    const agentIds =
      actor.kind === "agent"
        ? [actor.agentId]
        : (
            await this.db.agent.findMany({
              where: { workspaceId: actor.workspaceId, ownerId: userId, deletedAt: null },
              select: { id: true },
              take: 100,
              orderBy: { id: "asc" },
            })
          ).map((a) => a.id);
    if (agentIds.length >= 100) throw new MemoryError("unavailable");
    const enabled = await platformMemoryEnabled(this.db, {
      workspaceId: actor.workspaceId,
      ...(actor.kind === "agent" ? { ownerId: userId } : {}),
    });
    return {
      enabled,
      admin: actor.kind === "user" && ["owner", "admin"].includes(membership.role),
      agentIds,
    };
  }
  async get(workspaceId: string, id: string) {
    const row = await this.db.platformMemoryHead.findFirst({ where: { workspaceId, id } });
    return row ? head(row) : null;
  }
  async receipt(workspaceId: string, actor: string, requestId: string) {
    return this.db.platformMemoryReceipt.findUnique({
      where: { workspaceId_actor_requestId: { workspaceId, actor, requestId } },
      select: { fingerprint: true, entryId: true, deleted: true },
    });
  }
  async reserve(
    input: Omit<MemoryHead, "id" | "createdAt" | "updatedAt">,
    createRequestId: string,
    fingerprint: string,
    dedupKeys: string[],
  ) {
    const where = {
      workspaceId_author_createRequestId: {
        workspaceId: input.workspaceId,
        author: input.author,
        createRequestId,
      },
    };
    let row = await this.db.platformMemoryHead.findUnique({ where });
    if (row) {
      if (row.fingerprint !== fingerprint) throw new MemoryError("conflict");
      return head(row);
    }
    try {
      row = await this.db.platformMemoryHead.create({
        data: {
          workspaceId: input.workspaceId,
          scope: input.scope,
          agentId: input.agentId,
          author: input.author,
          dedupKey: input.dedupKey,
          createRequestId,
          fingerprint,
          title: input.title,
          kind: input.kind,
          uri: null,
          revision: 0,
          sourceMessageId: input.sourceMessageId,
          expiresAt: input.expiresAt,
          deletedAt: null,
          keys: { create: dedupKeys.map((key) => ({ workspaceId: input.workspaceId, key })) },
        },
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      row = await this.db.platformMemoryHead.findUnique({ where });
      if (row && row.fingerprint !== fingerprint) throw new MemoryError("conflict");
      if (!row) {
        const aliases = await this.db.platformMemoryKey.findMany({
          where: { workspaceId: input.workspaceId, key: { in: dedupKeys } },
          select: { entryId: true },
          take: 3,
        });
        if (new Set(aliases.map((alias) => alias.entryId)).size !== 1)
          throw new MemoryError("conflict");
        row = await this.db.platformMemoryHead.findUnique({ where: { id: aliases[0]!.entryId } });
      }
    }
    if (!row) throw new MemoryError("conflict");
    return head(row);
  }
  async commit(input: Parameters<MemoryStore["commit"]>[0]) {
    try {
      return await this.db.$transaction(async (tx) => {
        const changed = await tx.platformMemoryHead.updateMany({
          where: {
            workspaceId: input.head.workspaceId,
            id: input.head.id,
            revision: input.expectedRevision,
            deletedAt: null,
          },
          data: {
            dedupKey: input.head.dedupKey,
            uri: input.head.uri,
            title: input.head.title,
            kind: input.head.kind,
            revision: input.head.revision,
            sourceMessageId: input.head.sourceMessageId,
            expiresAt: input.head.expiresAt,
            deletedAt: input.head.deletedAt,
          },
        });
        if (changed.count !== 1) return false;
        if (input.dedupKeys.length) {
          await tx.platformMemoryKey.createMany({
            data: input.dedupKeys.map((key) => ({
              workspaceId: input.head.workspaceId,
              key,
              entryId: input.head.id,
            })),
            skipDuplicates: true,
          });
          const collision = await tx.platformMemoryKey.findFirst({
            where: {
              workspaceId: input.head.workspaceId,
              key: { in: input.dedupKeys },
              entryId: { not: input.head.id },
            },
            select: { key: true },
          });
          if (collision) throw new MemoryError("conflict");
        }
        await tx.platformMemoryReceipt.create({
          data: {
            workspaceId: input.head.workspaceId,
            actor: input.actor,
            requestId: input.requestId,
            fingerprint: input.fingerprint,
            entryId: input.head.id,
            deleted: input.deleted,
          },
        });
        return true;
      });
    } catch (error) {
      if (isUniqueViolation(error)) return false;
      throw error;
    }
  }
  async list(input: Parameters<MemoryStore["list"]>[0]) {
    const [rows, meta] = await paginated(this.db)
      .platformMemoryHead.paginate({
        where: {
          ...visible(input.workspaceId, input.agentIds, input.now),
          ...(input.scope ? { scope: input.scope } : {}),
        },
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      })
      .withPages({ limit: 20, page: input.page, includePageCount: true });
    return { entries: rows.map(head), pageCount: meta.pageCount };
  }
  async current(workspaceId: string, uris: string[], agentIds: string[], now: Date) {
    if (uris.length === 0) return [];
    return (
      await this.db.platformMemoryHead.findMany({
        where: { ...visible(workspaceId, agentIds, now), uri: { in: uris.slice(0, 200) } },
        take: 200,
      })
    ).map(head);
  }
  async searchUris(
    workspaceId: string,
    agentIds: string[],
    scope: MemoryHead["scope"] | undefined,
    now: Date,
  ) {
    return (
      await this.db.platformMemoryHead.findMany({
        where: { ...visible(workspaceId, agentIds, now), ...(scope ? { scope } : {}) },
        select: { uri: true },
        orderBy: { id: "asc" },
        take: 1001,
      })
    ).flatMap((row) => (row.uri ? [row.uri] : []));
  }
  async sourceAllowed(actor: MemoryActor, id: string) {
    return Boolean(
      await this.db.message.findFirst({
        where: {
          id,
          workspaceId: actor.workspaceId,
          sender: actor.kind === "agent" ? { agentId: actor.agentId } : { userId: actor.userId },
        },
        select: { id: true },
      }),
    );
  }
}
