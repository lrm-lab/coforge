import { Prisma, type PrismaClient } from "#src/generated/prisma/client";
import { readableArtifactNoticeSql } from "#src/server/artifacts/artifact-notice-visibility.server";
import { AgentMessageValidationError } from "#src/server/conversations/agent-message-validation-error.server";
import { assertMessageAnchor } from "./direct-conversation-anchor.server";
import {
  AGENT_MESSAGE_INCLUDE,
  type DirectConversationMessageRow,
} from "./direct-conversation-agent-message.server";

type Scope = {
  workspaceId: string;
  agentId: string;
  conversationId: string;
  fromSequence?: number;
  throughSequence?: number;
};

const rangeSql = (scope: Scope) => Prisma.sql`
  ${scope.fromSequence === undefined ? Prisma.empty : Prisma.sql`AND msg."sequence" >= ${scope.fromSequence}`}
  ${scope.throughSequence === undefined ? Prisma.empty : Prisma.sql`AND msg."sequence" <= ${scope.throughSequence}`}`;

type Bound = {
  atOrBelow?: number;
  below?: number;
  atOrAbove?: number;
  above?: number;
  restrictedTo?: string[];
};

const boundSql = (bound: Bound) => Prisma.sql`
  ${bound.atOrBelow === undefined ? Prisma.empty : Prisma.sql`AND msg."sequence" <= ${bound.atOrBelow}`}
  ${bound.below === undefined ? Prisma.empty : Prisma.sql`AND msg."sequence" < ${bound.below}`}
  ${bound.atOrAbove === undefined ? Prisma.empty : Prisma.sql`AND msg."sequence" >= ${bound.atOrAbove}`}
  ${bound.above === undefined ? Prisma.empty : Prisma.sql`AND msg."sequence" > ${bound.above}`}
  ${bound.restrictedTo === undefined ? Prisma.empty : Prisma.sql`AND msg."id" IN (${Prisma.join(bound.restrictedTo)})`}`;

function noticeIdsSql(
  scope: Scope,
  bound: Bound,
  direction: "asc" | "desc",
  limit: number,
): Prisma.Sql {
  return Prisma.sql`
    SELECT msg."id"
    FROM "messages" msg
    WHERE msg."conversationId" = ${scope.conversationId}::uuid
      AND msg."workspaceId" = ${scope.workspaceId}::uuid
      AND msg."threadRootId" IS NULL
      ${rangeSql(scope)}
      ${boundSql(bound)}
      AND ${readableArtifactNoticeSql(scope.workspaceId, scope.agentId, Prisma.sql`msg."id"`)}
    ORDER BY msg."sequence" ${Prisma.raw(direction.toUpperCase())}
    LIMIT ${limit}`;
}

async function ids(
  db: PrismaClient,
  scope: Scope,
  bound: Bound,
  direction: "asc" | "desc",
  limit: number,
) {
  const rows = await db.$queryRaw<{ id: string }[]>(noticeIdsSql(scope, bound, direction, limit));
  return rows.map((row) => row.id);
}

export async function resolveNoticeAnchor(db: PrismaClient, scope: Scope, anchor: string) {
  assertMessageAnchor(anchor);
  const rows = await db.$queryRaw<{ id: string; sequence: number }[]>`
    SELECT msg."id", msg."sequence"
    FROM "messages" msg
    WHERE msg."conversationId" = ${scope.conversationId}::uuid
      AND msg."workspaceId" = ${scope.workspaceId}::uuid
      AND msg."threadRootId" IS NULL
      AND msg."id"::text LIKE ${`${anchor.toLowerCase()}%`}
      AND ${readableArtifactNoticeSql(scope.workspaceId, scope.agentId, Prisma.sql`msg."id"`)}
    ORDER BY msg."sequence" ASC
    LIMIT 2`;
  if (rows.length > 1)
    throw new AgentMessageValidationError(
      "ambiguous message prefix; use the full UUID",
      rows.map((row) => row.id),
    );
  const match = rows[0];
  return match ? { id: match.id, sequence: match.sequence, threadRootId: null } : undefined;
}

export async function noticePositionIsBlocked(db: PrismaClient, scope: Scope, sequence: number) {
  const rows = await db.$queryRaw<{ readable: boolean }[]>`
    SELECT (${readableArtifactNoticeSql(scope.workspaceId, scope.agentId, Prisma.sql`msg."id"`)}) AS "readable"
    FROM "messages" msg
    WHERE msg."conversationId" = ${scope.conversationId}::uuid
      AND msg."workspaceId" = ${scope.workspaceId}::uuid
      AND msg."threadRootId" IS NULL
      AND msg."sequence" = ${sequence}
    LIMIT 1`;
  return rows[0] !== undefined && !rows[0].readable;
}

async function hydrate(db: PrismaClient, pageIds: string[]) {
  if (pageIds.length === 0) return [];
  const fetched = await db.message.findMany({
    where: { id: { in: pageIds } },
    include: AGENT_MESSAGE_INCLUDE,
  });
  const byId = new Map(fetched.map((row) => [row.id, row] as const));
  return pageIds.flatMap((id) => {
    const row = byId.get(id);
    return row ? [row as DirectConversationMessageRow] : [];
  });
}

type EdgePart = { part: "page" | "older" | "newer"; id: string; sequence: number };

async function confirmPageAndProbeEdges(
  db: PrismaClient,
  scope: Scope,
  pageIds: string[],
  olderRow: Prisma.Sql,
  newerRow: Prisma.Sql,
) {
  const pageRows =
    pageIds.length === 0 ? Prisma.sql`FALSE` : Prisma.sql`r."id" IN (${Prisma.join(pageIds)})`;
  return db.$queryRaw<EdgePart[]>`
    WITH "readable" AS (
      SELECT msg."id", msg."sequence"
      FROM "messages" msg
      WHERE msg."conversationId" = ${scope.conversationId}::uuid
        AND msg."workspaceId" = ${scope.workspaceId}::uuid
        AND msg."threadRootId" IS NULL
        ${rangeSql(scope)}
        AND ${readableArtifactNoticeSql(scope.workspaceId, scope.agentId, Prisma.sql`msg."id"`)}
    ), "page" AS (
      SELECT r."id", r."sequence" FROM "readable" r WHERE ${pageRows}
    )
    SELECT 'page' AS "part", page."id", page."sequence" FROM "page" page
    UNION ALL
    (SELECT 'older', r."id", r."sequence" FROM "readable" r
      WHERE ${olderRow} ORDER BY r."sequence" DESC LIMIT 1)
    UNION ALL
    (SELECT 'newer', r."id", r."sequence" FROM "readable" r
      WHERE ${newerRow} ORDER BY r."sequence" ASC LIMIT 1)`;
}

export async function readNoticePage(
  db: PrismaClient,
  input: Scope & {
    anchorSequence: number | undefined;
    before: boolean;
    after: boolean;
    around: boolean;
    unread: boolean;
    limit: number;
  },
): Promise<{ rows: DirectConversationMessageRow[]; hasOlder: boolean; hasNewer: boolean }> {
  const scope: Scope = {
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    conversationId: input.conversationId,
    ...(input.fromSequence === undefined ? {} : { fromSequence: input.fromSequence }),
    ...(input.throughSequence === undefined ? {} : { throughSequence: input.throughSequence }),
  };
  const { anchorSequence, limit } = input;
  const older = anchorSequence === undefined ? undefined : { below: anchorSequence };
  const around = input.around && anchorSequence !== undefined;
  const beforeCount = Math.floor((limit - 1) / 2);
  const afterCount = limit - 1 - beforeCount;
  const unreadFromStart =
    input.unread && anchorSequence === undefined && !input.before && !input.after;
  const pageIds = unreadFromStart
    ? (await ids(db, scope, {}, "asc", limit + 1)).slice(0, limit)
    : around && anchorSequence !== undefined
      ? [
          ...(await ids(db, scope, { below: anchorSequence }, "desc", beforeCount + 1)).slice(
            0,
            beforeCount,
          ),
          ...(await ids(
            db,
            scope,
            { atOrBelow: anchorSequence, atOrAbove: anchorSequence },
            "asc",
            1,
          )),
          ...(await ids(db, scope, { above: anchorSequence }, "asc", afterCount + 1)).slice(
            0,
            afterCount,
          ),
        ]
      : input.before && older
        ? (await ids(db, scope, older, "desc", limit + 1)).slice(0, limit)
        : input.after && anchorSequence !== undefined
          ? (await ids(db, scope, { above: anchorSequence }, "asc", limit + 1)).slice(0, limit)
          : await ids(db, scope, {}, "desc", limit);
  const rows = (await hydrate(db, pageIds)).sort((a, b) => a.sequence - b.sequence);
  const anchor =
    anchorSequence ??
    (unreadFromStart && scope.fromSequence !== undefined ? scope.fromSequence - 1 : null);
  const anchorAt = (comparison: "atOrBelow" | "atOrAbove") =>
    anchor === null
      ? Prisma.sql`FALSE`
      : Prisma.sql`r."sequence" ${Prisma.raw(comparison === "atOrBelow" ? "<=" : ">=")} ${anchor}::int`;
  const sameSide = (comparison: "<" | ">") =>
    anchor === null
      ? Prisma.empty
      : Prisma.sql`WHERE edge."sequence" ${Prisma.raw(comparison)} ${anchor}::int`;
  const parts = await confirmPageAndProbeEdges(
    db,
    scope,
    pageIds,
    input.after
      ? anchorAt("atOrBelow")
      : Prisma.sql`r."sequence" < COALESCE((SELECT min(edge."sequence") FROM "page" edge ${sameSide("<")}), ${anchor}::int)`,
    input.before
      ? anchorAt("atOrAbove")
      : Prisma.sql`r."sequence" > COALESCE((SELECT max(edge."sequence") FROM "page" edge ${sameSide(">")}), ${anchor}::int)`,
  );
  const confirmed = new Set(parts.filter((row) => row.part === "page").map((row) => row.id));
  const readable = rows.filter((row) => confirmed.has(row.id));
  return {
    rows: readable,
    hasOlder: unreadFromStart ? false : parts.some((row) => row.part === "older"),
    hasNewer: parts.some((row) => row.part === "newer"),
  };
}
