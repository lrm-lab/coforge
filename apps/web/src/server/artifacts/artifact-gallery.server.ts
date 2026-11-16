import { readMessageReferences } from "@lrm/coforge-sdk/internal/message-references";
import { Prisma, type PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import { containsPattern, searchTerms } from "#src/lib/search-terms";
import {
  artifactTier,
  artifactViewer,
  type ArtifactViewer,
  artifactsDisabled,
  requireConversationHome,
} from "./artifact-access.server";
import type { ArtifactReads } from "./artifact-reads.server";
import { epochTimestamp, visibleToReaderSql } from "./artifact-visible.server";

export type GallerySort = "opened" | "updated";

export type GalleryScope =
  | { kind: "conversation"; conversationId: string }
  | { kind: "workspace" }
  | { kind: "link" };

type GalleryInput = {
  workspaceId: string;
  userId: string;
  query?: string;
  scope?: GalleryScope;
  authorAgentIds?: readonly string[];
  related?: boolean;
  sort: GallerySort;
  cursor?: string;
  limit: number;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const writeCursor = (key: number, updatedAt: number, id: string) =>
  Buffer.from(JSON.stringify([key, updatedAt, id])).toString("base64url");

function readCursor(cursor: string): { key: number; updatedAt: number; id: string } {
  try {
    const [key, updatedAt, id] = JSON.parse(
      Buffer.from(cursor, "base64url").toString(),
    ) as unknown[];
    if (
      typeof key === "number" &&
      Number.isFinite(key) &&
      typeof updatedAt === "number" &&
      Number.isFinite(updatedAt) &&
      typeof id === "string" &&
      UUID.test(id)
    )
      return { key, updatedAt, id };
  } catch {}
  throw new AppError("INVALID_INPUT", { errorId: "artifact-list-cursor" });
}

const CARD_SELECT = {
  id: true,
  title: true,
  entryPath: true,
  homeKey: true,
  access: true,
  currentVersion: true,
  preview: true,
  authorAgentId: true,
  updatedAt: true,
} as const;

export class ArtifactGallery {
  constructor(
    private readonly db: PrismaClient,
    private readonly enabled: (workspaceId: string) => Promise<boolean>,
    private readonly reads: Pick<ArtifactReads, "cards">,
  ) {}

  async marks(input: { workspaceId: string; userId: string; artifactIds: readonly string[] }) {
    const readable = await this.reads.cards({
      workspaceId: input.workspaceId,
      reader: { userId: input.userId },
      artifactIds: input.artifactIds,
    });
    const cards = await this.cards(
      input.userId,
      readable.map((card) => card.id),
    );
    return cards.map(
      ({ id, link, openedAt, commentCount, hasUpdates, newComments, mentionsYou }) => ({
        id,
        link,
        openedAt,
        commentCount,
        hasUpdates,
        newComments,
        mentionsYou,
      }),
    );
  }

  async page(input: GalleryInput) {
    if (!(await this.enabled(input.workspaceId))) throw artifactsDisabled();
    const reader = { userId: input.userId };
    const viewer = await artifactViewer(this.db, input.workspaceId, reader);
    if (!viewer.member) throw new AppError("NOT_FOUND");
    if (input.scope?.kind === "conversation")
      await requireConversationHome(
        this.db,
        input.workspaceId,
        reader,
        input.scope.conversationId,
        "read",
        viewer,
      );
    const after = input.cursor === undefined ? undefined : readCursor(input.cursor);
    const ids = await this.#pagedIds(input, viewer, after);
    const page = ids.slice(0, input.limit);
    const last = page.at(-1);
    return {
      artifacts: await this.cards(
        input.userId,
        page.map((row) => row.id),
      ),
      ...(ids.length > input.limit && last
        ? { nextCursor: writeCursor(last.key, last.updatedAt, last.id) }
        : {}),
    };
  }

  async #pagedIds(
    input: GalleryInput,
    viewer: ArtifactViewer,
    after: { key: number; updatedAt: number; id: string } | undefined,
  ) {
    const { workspaceId, userId } = input;
    const key =
      input.sort === "opened"
        ? Prisma.sql`COALESCE(p."openedAt", TIMESTAMP 'epoch')`
        : Prisma.sql`a."updatedAt"`;
    const where = [
      visibleToReaderSql({
        workspaceId,
        reader: { userId },
        viewer,
        conversationId:
          input.scope?.kind === "conversation" ? input.scope.conversationId : undefined,
      }),
      ...searchTerms(input.query ?? "").map(
        (word) => Prisma.sql`a."title" ILIKE ${containsPattern(word)}`,
      ),
      ...this.#scopeFilters(input),
      ...(input.related ? [this.#relatedSql(workspaceId, userId)] : []),
      ...(after
        ? [
            Prisma.sql`(${key}, a."updatedAt", a."id") < (${epochTimestamp(new Date(after.key))},
              ${epochTimestamp(new Date(after.updatedAt))}, ${after.id}::uuid)`,
          ]
        : []),
    ];
    const rows = await this.db.$queryRaw<{ id: string; key: Date; updatedAt: Date }[]>`
      SELECT a."id", ${key} AS "key", a."updatedAt" FROM "artifacts" a
      LEFT JOIN "artifact_viewer_positions" p
        ON p."artifactId" = a."id" AND p."userId" = ${userId}::uuid
      WHERE a."workspaceId" = ${workspaceId}::uuid AND a."deletedAt" IS NULL
        AND ${Prisma.join(where, " AND ")}
      ORDER BY ${key} DESC, a."updatedAt" DESC, a."id" DESC
      LIMIT ${input.limit + 1}`;
    return rows.map((row) => ({
      id: row.id,
      key: row.key.getTime(),
      updatedAt: row.updatedAt.getTime(),
    }));
  }

  #scopeFilters(input: GalleryInput): Prisma.Sql[] {
    return [
      ...(input.scope?.kind === "workspace"
        ? [Prisma.sql`(a."access" = 'workspace' OR a."homeKey" = 'workspace')`]
        : []),
      ...(input.scope?.kind === "link"
        ? [
            Prisma.sql`EXISTS (SELECT 1 FROM "artifact_public_links" l
              WHERE l."artifactId" = a."id" AND l."revokedAt" IS NULL)`,
          ]
        : []),
      ...(input.authorAgentIds?.length
        ? [
            Prisma.sql`a."authorAgentId" IN (${Prisma.join(
              input.authorAgentIds.map((id) => Prisma.sql`${id}::uuid`),
            )})`,
          ]
        : []),
    ];
  }

  #relatedSql(workspaceId: string, userId: string): Prisma.Sql {
    return Prisma.sql`(
      a."authorAgentId" IN (
        SELECT "id" FROM "agents" WHERE "workspaceId" = ${workspaceId}::uuid
          AND "ownerId" = ${userId}::uuid)
      OR EXISTS (SELECT 1 FROM "artifact_comments" c
        WHERE c."artifactId" = a."id" AND c."deletedAt" IS NULL
          AND c."authorUserId" = ${userId}::uuid)
      OR EXISTS (SELECT 1 FROM "artifact_follows" f
        WHERE f."artifactId" = a."id" AND f."userId" = ${userId}::uuid AND f."following"))`;
  }

  async #unseenComments(userId: string, ids: readonly string[]) {
    const rows = await this.db.$queryRaw<
      { artifactId: string; newComments: number; candidates: string[]; username: string }[]
    >`
      SELECT c."artifactId", COUNT(*)::int AS "newComments", u."username",
        COALESCE(ARRAY_AGG(c."body") FILTER (WHERE c."body" ILIKE '%@' || u."username" || '%'),
          '{}') AS "candidates"
      FROM "artifact_comments" c
      JOIN "users" u ON u."id" = ${userId}::uuid
      JOIN "artifact_viewer_positions" p
        ON p."artifactId" = c."artifactId" AND p."userId" = ${userId}::uuid
      WHERE c."artifactId" IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))})
        AND c."deletedAt" IS NULL
        AND (c."authorUserId" IS NULL OR c."authorUserId" <> ${userId}::uuid)
        AND c."createdAt" > p."openedAt"
      GROUP BY c."artifactId", u."username"`;
    return new Map(rows.map((row) => [row.artifactId, row]));
  }

  private async cards(userId: string, ids: readonly string[]) {
    if (ids.length === 0) return [];
    const [rows, positions, links, counts, unseenByArtifact] = await Promise.all([
      this.db.artifact.findMany({ where: { id: { in: [...ids] } }, select: CARD_SELECT }),
      this.db.artifactViewerPosition.findMany({
        where: { userId, artifactId: { in: [...ids] } },
      }),
      this.db.artifactPublicLink.findMany({
        where: { artifactId: { in: [...ids] }, revokedAt: null },
        select: { artifactId: true },
      }),
      this.db.artifactComment.groupBy({
        by: ["artifactId"],
        where: { artifactId: { in: [...ids] }, deletedAt: null },
        _count: { _all: true },
      }),
      this.#unseenComments(userId, ids),
    ]);
    const byId = new Map(rows.map((row) => [row.id, row]));
    const position = new Map(positions.map((row) => [row.artifactId, row]));
    const linked = new Set(links.map((row) => row.artifactId));
    const total = new Map(counts.map((row) => [row.artifactId, row._count._all]));
    return ids.flatMap((id) => {
      const row = byId.get(id);
      if (!row) return [];
      const { authorAgentId, ...shown } = row;
      const place = position.get(id);
      const unseen = unseenByArtifact.get(id);
      const tier = artifactTier(row);
      return [
        {
          ...shown,
          homeKey: tier === "workspace" ? "workspace" : row.homeKey,
          access: tier,
          author: authorAgentId ? { agentId: authorAgentId } : null,
          link: linked.has(id),
          openedAt: place?.openedAt ?? null,
          commentCount: total.get(id) ?? 0,
          hasUpdates: place !== undefined && place.seenVersion < row.currentVersion,
          newComments: unseen?.newComments ?? 0,
          mentionsYou:
            unseen !== undefined &&
            unseen.candidates.some((body) => mentions(body, unseen.username)),
        },
      ];
    });
  }
}

const mentions = (body: string, username: string) =>
  readMessageReferences(body).candidates.handles.some(
    (handle) => handle.toLowerCase() === username.toLowerCase(),
  );
