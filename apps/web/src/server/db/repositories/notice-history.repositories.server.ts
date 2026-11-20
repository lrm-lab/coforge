import { Prisma, type PrismaClient } from "#src/generated/prisma/client";
import { readableArtifactNoticeSql } from "#src/server/artifacts/artifact-notice-visibility.server";
import { AgentMessageValidationError } from "#src/server/conversations/agent-message-validation-error.server";
import {
  AGENT_MESSAGE_INCLUDE,
  type DirectConversationMessageRow,
} from "./direct-conversation-agent-message.server";

type Scope = { workspaceId: string; agentId: string; conversationId: string };

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
  const rows = await db.$queryRaw<{ id: string; sequence: number }[]>`
    SELECT msg."id", msg."sequence"
    FROM "messages" msg
    WHERE msg."conversationId" = ${scope.conversationId}::uuid
      AND msg."workspaceId" = ${scope.workspaceId}::uuid
      AND msg."threadRootId" IS NULL
      AND msg."id"::text LIKE ${`${anchor}%`}
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

export async function readNoticePage(
  db: PrismaClient,
  input: Scope & {
    anchorSequence: number | undefined;
    before: boolean;
    after: boolean;
    around: boolean;
    limit: number;
  },
): Promise<{ rows: DirectConversationMessageRow[]; hasOlder: boolean; hasNewer: boolean }> {
  const scope = {
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    conversationId: input.conversationId,
  };
  const { anchorSequence, limit } = input;
  const older = anchorSequence === undefined ? undefined : { below: anchorSequence };
  const around = input.around && anchorSequence !== undefined;
  const beforeCount = Math.floor((limit - 1) / 2);
  const afterCount = limit - 1 - beforeCount;
  const pageIds =
    around && anchorSequence !== undefined
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
  const confirmed = new Set(
    pageIds.length === 0 ? [] : await ids(db, scope, { restrictedTo: pageIds }, "asc", limit),
  );
  const readable = rows.filter((row) => confirmed.has(row.id));
  const minSequence = readable[0]?.sequence;
  const maxSequence = readable.at(-1)?.sequence;
  const olderFrom =
    around && anchorSequence !== undefined && minSequence === undefined
      ? anchorSequence
      : minSequence;
  const newerFrom =
    around && anchorSequence !== undefined && maxSequence === undefined
      ? anchorSequence
      : maxSequence;
  const olderThanPage =
    olderFrom === undefined
      ? false
      : (await ids(db, scope, { below: olderFrom }, "desc", 1)).length > 0;
  const newerThanPage =
    newerFrom === undefined
      ? false
      : (await ids(db, scope, { above: newerFrom }, "asc", 1)).length > 0;
  const olderThanAnchor =
    anchorSequence === undefined
      ? false
      : (await ids(db, scope, { atOrBelow: anchorSequence }, "desc", 1)).length > 0;
  const newerThanAnchor =
    anchorSequence === undefined
      ? false
      : (await ids(db, scope, { atOrAbove: anchorSequence }, "asc", 1)).length > 0;
  return {
    rows: readable,
    hasOlder: input.after ? olderThanAnchor : olderThanPage,
    hasNewer: input.before ? newerThanAnchor : newerThanPage,
  };
}
