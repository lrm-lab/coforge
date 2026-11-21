import { Prisma, type PrismaClient } from "#src/generated/prisma/client";
import type {
  ActivityInboxCursor,
  ActivityInboxFilter,
} from "#src/features/inbox/activity-inbox.schemas";
import { oneLine } from "#src/features/conversations/preview-line";
import { visibleToMemberSql } from "./artifact-visible.server";

export type ArtifactActivityEventKind = "comment" | "comment_edited" | "review" | "version";

export type ArtifactActivityRow = {
  artifactId: string;
  eventKind: ArtifactActivityEventKind;
  eventId: string;
  latestMentions: boolean;
  unreadComments: number;
  unreadVersions: number;
};

export type ArtifactListedRow = {
  unreadItemCount: number;
  unreadMentionItemCount: number;
  activeItemCount: number;
  artifactId: string | null;
  key: string | null;
  latestAt: Date | null;
  hasUnread: boolean | null;
  unreadMention: boolean | null;
};

export type ArtifactDoneRow = {
  artifactId: string;
  previousReadAt: Date | null;
  previousDoneAt: Date | null;
  through: Date;
};

const NEVER = Prisma.sql`'-infinity'::timestamp`;
const dbNow = Prisma.sql`(now() AT TIME ZONE 'UTC')`;

const othersComment = (userId: string) =>
  Prisma.sql`c."deletedAt" IS NULL AND (c."authorUserId" IS NULL OR c."authorUserId" <> ${userId}::uuid)`;

const othersVersion = (userId: string) =>
  Prisma.sql`(v."publisherUserId" IS NULL OR v."publisherUserId" <> ${userId}::uuid)`;

function followsSql(workspaceId: string, userId: string, artifactIds?: readonly string[]) {
  const only = artifactIds
    ? Prisma.sql`AND a."id" IN (${Prisma.join(artifactIds.map((id) => Prisma.sql`${id}::uuid`))})`
    : Prisma.empty;
  return Prisma.sql`
    SELECT a."id" AS "artifactId", f."followedAt",
      COALESCE(f."doneAt", ${NEVER}) AS "doneAt",
      COALESCE(GREATEST(f."readAt", f."doneAt", p."openedAt"), ${NEVER}) AS "readAt"
    FROM "artifact_follows" f
    JOIN "artifacts" a ON a."id" = f."artifactId"
    LEFT JOIN "artifact_viewer_positions" p
      ON p."artifactId" = a."id" AND p."userId" = f."userId"
    WHERE f."userId" = ${userId}::uuid AND f."following"
      AND a."workspaceId" = ${workspaceId}::uuid AND a."deletedAt" IS NULL ${only}
      AND ${visibleToMemberSql(workspaceId, userId)}`;
}

type Boundary = "doneAt" | "readAt";

function eventAfterSql(userId: string, boundary: Boundary, upTo?: Prisma.Sql) {
  const after = Prisma.raw(`fo."${boundary}"`);
  const bound = (column: string) =>
    upTo ? Prisma.sql`AND ${Prisma.raw(column)} <= ${upTo}` : Prisma.empty;
  return Prisma.sql`(
    EXISTS (SELECT 1 FROM "artifact_comments" c
      WHERE c."artifactId" = fo."artifactId" AND ${othersComment(userId)}
        AND c."createdAt" >= fo."followedAt" AND c."createdAt" > ${after} ${bound('c."createdAt"')})
    OR EXISTS (SELECT 1 FROM "artifact_comments" c
      WHERE c."artifactId" = fo."artifactId" AND ${othersComment(userId)}
        AND c."editedAt" >= fo."followedAt" AND c."editedAt" > ${after} ${bound('c."editedAt"')})
    OR EXISTS (SELECT 1 FROM "artifact_versions" v
      WHERE v."artifactId" = fo."artifactId" AND ${othersVersion(userId)}
        AND v."createdAt" >= fo."followedAt" AND v."createdAt" > ${after} ${bound('v."createdAt"')}))`;
}

function mentionAfterSql(userId: string, boundary: Boundary) {
  const after = Prisma.raw(`fo."${boundary}"`);
  return Prisma.sql`EXISTS (SELECT 1 FROM "artifact_comment_mentions" mm
    WHERE mm."artifactId" = fo."artifactId" AND mm."userId" = ${userId}::uuid
      AND mm."mentionedAt" >= fo."followedAt" AND mm."mentionedAt" > ${after})`;
}

function viewSql(filter: ActivityInboxFilter) {
  if (filter === "unread") return Prisma.sql`listed."hasUnread"`;
  if (filter === "mentions") return Prisma.sql`listed."hasMention"`;
  return Prisma.sql`TRUE`;
}

export function artifactActivityPageSql(
  workspaceId: string,
  userId: string,
  options: { filter: ActivityInboxFilter; cursor?: ActivityInboxCursor | undefined; limit: number },
) {
  const { cursor } = options;
  const unreadFirst = options.filter === "all";
  const unread = cursor && "hasUnread" in cursor ? Prisma.sql`listed."hasUnread",` : Prisma.empty;
  const boundary =
    cursor && "hasUnread" in cursor ? Prisma.sql`${cursor.hasUnread}::boolean,` : Prisma.empty;
  const after = cursor
    ? Prisma.sql`(${unread} listed."latestAt", 0, listed."key" COLLATE "C")
        < (${boundary} ${new Date(cursor.at).toISOString()}::timestamp(3), ${cursor.sequence}::int,
           ${cursor.key}::text COLLATE "C")`
    : Prisma.sql`TRUE`;
  return Prisma.sql`
    WITH follows AS MATERIALIZED (${followsSql(workspaceId, userId)}),
    listed AS MATERIALIZED (
      SELECT fo."artifactId", 'artifact:' || fo."artifactId" AS "key", latest."at" AS "latestAt",
        ${eventAfterSql(userId, "readAt")} AS "hasUnread",
        ${mentionAfterSql(userId, "readAt")} AS "unreadMention",
        ${mentionAfterSql(userId, "doneAt")} AS "hasMention"
      FROM follows fo
      CROSS JOIN LATERAL (
        SELECT GREATEST(
          (SELECT c."createdAt" FROM "artifact_comments" c
            WHERE c."artifactId" = fo."artifactId" AND ${othersComment(userId)}
              AND c."createdAt" >= fo."followedAt"
            ORDER BY c."createdAt" DESC LIMIT 1),
          (SELECT MAX(c."editedAt") FROM "artifact_comments" c
            WHERE c."artifactId" = fo."artifactId" AND ${othersComment(userId)}
              AND c."editedAt" >= fo."followedAt"),
          (SELECT v."createdAt" FROM "artifact_versions" v
            WHERE v."artifactId" = fo."artifactId" AND ${othersVersion(userId)}
              AND v."createdAt" >= fo."followedAt"
            ORDER BY v."number" DESC LIMIT 1)
        ) AS "at"
      ) latest
      WHERE ${eventAfterSql(userId, "doneAt")}
    ), page AS (
      SELECT * FROM listed
      WHERE ${viewSql(options.filter)} AND ${after}
      ORDER BY ${unreadFirst ? Prisma.sql`listed."hasUnread" DESC,` : Prisma.empty}
        listed."latestAt" DESC, listed."key" COLLATE "C" DESC
      LIMIT ${options.limit + 1}
    ), counts AS (
      SELECT (COUNT(*) FILTER (WHERE listed."hasUnread"))::int AS "unreadItemCount",
        (COUNT(*) FILTER (WHERE listed."unreadMention"))::int AS "unreadMentionItemCount",
        COUNT(*)::int AS "activeItemCount"
      FROM listed
    )
    SELECT counts.*, page."artifactId", page."key", page."latestAt", page."hasUnread",
      page."unreadMention"
    FROM counts LEFT JOIN page ON TRUE
    ORDER BY ${unreadFirst ? Prisma.sql`page."hasUnread" DESC NULLS LAST,` : Prisma.empty}
      page."latestAt" DESC NULLS LAST, page."key" COLLATE "C" DESC`;
}

export function artifactUnreadKeysSql(workspaceId: string, userId: string, artifactId?: string) {
  return Prisma.sql`
    WITH follows AS MATERIALIZED (${followsSql(workspaceId, userId, artifactId ? [artifactId] : undefined)})
    SELECT 'artifact:' || fo."artifactId" AS "key",
      GREATEST(fo."readAt", fo."followedAt") AS "latestAt"
    FROM follows fo
    WHERE ${eventAfterSql(userId, "readAt")}`;
}

export function artifactActivityRowsSql(
  workspaceId: string,
  userId: string,
  artifactIds: readonly string[],
) {
  return Prisma.sql`
    WITH follows AS MATERIALIZED (${followsSql(workspaceId, userId, artifactIds)}),
    events AS (
      SELECT c."id", c."artifactId",
        GREATEST(c."createdAt", COALESCE(c."editedAt", c."createdAt")) AS "at", fo."readAt",
        CASE WHEN c."editedAt" > c."createdAt" THEN 'comment_edited'
          WHEN c."reviewId" IS NOT NULL THEN 'review' ELSE 'comment' END AS "kind",
        CASE WHEN c."editedAt" > c."createdAt" THEN c."id"
          ELSE COALESCE(c."reviewId", c."id") END AS "eventId"
      FROM follows fo
      JOIN "artifact_comments" c ON c."artifactId" = fo."artifactId" AND ${othersComment(userId)}
        AND (c."createdAt" >= fo."followedAt" OR c."editedAt" >= fo."followedAt")
    ),
    latest_comment AS (
      SELECT DISTINCT ON (e."artifactId") e."artifactId", e."kind", e."eventId", e."at"
      FROM events e ORDER BY e."artifactId", e."at" DESC, e."id" DESC
    ),
    comment_counts AS (
      SELECT e."artifactId", (COUNT(*) FILTER (WHERE e."at" > e."readAt"))::int AS "count"
      FROM events e GROUP BY e."artifactId"
    ),
    versions AS (
      SELECT v."id", v."artifactId", v."createdAt" AS "at", v."number", fo."readAt"
      FROM follows fo
      JOIN "artifact_versions" v ON v."artifactId" = fo."artifactId" AND ${othersVersion(userId)}
        AND v."createdAt" >= fo."followedAt"
    ),
    latest_version AS (
      SELECT DISTINCT ON (x."artifactId") x."artifactId", x."id", x."at"
      FROM versions x ORDER BY x."artifactId", x."number" DESC
    ),
    version_counts AS (
      SELECT x."artifactId", (COUNT(*) FILTER (WHERE x."at" > x."readAt"))::int AS "count"
      FROM versions x GROUP BY x."artifactId"
    )
    SELECT fo."artifactId",
      CASE WHEN lv."id" IS NOT NULL AND (lc."at" IS NULL OR lv."at" > lc."at")
        THEN 'version' ELSE lc."kind" END AS "eventKind",
      CASE WHEN lv."id" IS NOT NULL AND (lc."at" IS NULL OR lv."at" > lc."at")
        THEN lv."id" ELSE lc."eventId" END AS "eventId",
      COALESCE(men."latest" AND NOT (lv."id" IS NOT NULL AND (lc."at" IS NULL OR lv."at" > lc."at")),
        FALSE) AS "latestMentions",
      COALESCE(cc."count", 0) AS "unreadComments",
      COALESCE(vc."count", 0) AS "unreadVersions"
    FROM follows fo
    LEFT JOIN latest_comment lc ON lc."artifactId" = fo."artifactId"
    LEFT JOIN latest_version lv ON lv."artifactId" = fo."artifactId"
    LEFT JOIN comment_counts cc ON cc."artifactId" = fo."artifactId"
    LEFT JOIN version_counts vc ON vc."artifactId" = fo."artifactId"
    LEFT JOIN LATERAL (
      SELECT COALESCE(BOOL_OR(mm."commentId" = lc."eventId" OR mm."reviewId" = lc."eventId"
        OR mc."reviewId" = lc."eventId"), FALSE) AS "latest"
      FROM "artifact_comment_mentions" mm
      LEFT JOIN "artifact_comments" mc ON mc."id" = mm."commentId"
      WHERE mm."artifactId" = fo."artifactId" AND mm."userId" = ${userId}::uuid
        AND mm."mentionedAt" >= fo."followedAt"
    ) men ON TRUE`;
}

type Mark = { through: Date; artifactId?: string };

const only = (artifactId: string | undefined) =>
  artifactId ? Prisma.sql`AND fo."artifactId" = ${artifactId}::uuid` : Prisma.empty;

const throughOf = (mark: Mark) =>
  Prisma.sql`LEAST(${mark.through.toISOString()}::timestamp, ${dbNow})`;

export function readArtifactsSql(workspaceId: string, userId: string, mark: Mark) {
  return Prisma.sql`
    WITH follows AS MATERIALIZED (${followsSql(workspaceId, userId)}),
    target AS (
      SELECT fo."artifactId", ${throughOf(mark)} AS "through"
      FROM follows fo
      WHERE ${eventAfterSql(userId, "readAt", throughOf(mark))} ${only(mark.artifactId)}
    )
    UPDATE "artifact_follows" f
    SET "readAt" = GREATEST(f."readAt", target."through"), "updatedAt" = ${dbNow}
    FROM target
    WHERE f."userId" = ${userId}::uuid AND f."artifactId" = target."artifactId"
    RETURNING f."artifactId"`;
}

export function doneArtifactsSql(workspaceId: string, userId: string, mark: Mark) {
  return Prisma.sql`
    WITH follows AS MATERIALIZED (${followsSql(workspaceId, userId)}),
    target AS (
      SELECT fo."artifactId", ${throughOf(mark)} AS "through"
      FROM follows fo
      WHERE ${eventAfterSql(userId, "doneAt", throughOf(mark))} ${only(mark.artifactId)}
    ), previous AS (
      SELECT f."artifactId", f."readAt", f."doneAt" FROM "artifact_follows" f
      JOIN target ON f."artifactId" = target."artifactId" AND f."userId" = ${userId}::uuid
    )
    UPDATE "artifact_follows" f
    SET "readAt" = GREATEST(f."readAt", target."through"),
        "doneAt" = GREATEST(f."doneAt", target."through"), "updatedAt" = ${dbNow}
    FROM target, previous
    WHERE f."userId" = ${userId}::uuid AND f."artifactId" = target."artifactId"
      AND previous."artifactId" = f."artifactId"
    RETURNING f."artifactId", previous."readAt" AS "previousReadAt",
      previous."doneAt" AS "previousDoneAt", f."doneAt" AS "through"`;
}

type DoneUndo = {
  artifactId: string;
  previousReadAt: number | null;
  previousDoneAt: number | null;
  through: number;
};

const stamp = (at: number | null) => (at === null ? null : new Date(at).toISOString());

export function restoreArtifactsDoneSql(userId: string, rows: readonly DoneUndo[]) {
  const values = Prisma.join(
    rows.map(
      (row) =>
        Prisma.sql`(${row.artifactId}::uuid, ${stamp(row.previousReadAt)}::timestamp,
          ${stamp(row.previousDoneAt)}::timestamp, ${stamp(row.through)}::timestamp)`,
    ),
  );
  return Prisma.sql`
    UPDATE "artifact_follows" f
    SET "readAt" = CASE WHEN f."readAt" = undo."through" THEN undo."readAt" ELSE f."readAt" END,
        "doneAt" = undo."doneAt", "updatedAt" = ${dbNow}
    FROM (VALUES ${values}) AS undo("artifactId", "readAt", "doneAt", "through")
    WHERE f."userId" = ${userId}::uuid AND f."artifactId" = undo."artifactId"
      AND f."doneAt" = undo."through"`;
}

export type ArtifactActivityDetail = {
  artifact: { id: string; title: string; name: string; entryPath: string };
  mentioned: boolean;
  authorUserId: string | null;
  authorAgentId: string | null;
  kind: ArtifactActivityEventKind;
  preview: string;
  imageCount: number;
  reviewComments: number | null;
  version: number | null;
  target: { version: number | null; commentId: string | null; reviewId: string | null };
};

type DetailDb = Pick<
  PrismaClient,
  | "artifact"
  | "artifactComment"
  | "artifactCommentReview"
  | "artifactVersion"
  | "artifactCommentImage"
  | "$queryRaw"
>;

const idsOf = (rows: readonly ArtifactActivityRow[], kinds: readonly ArtifactActivityEventKind[]) =>
  rows.filter((row) => kinds.includes(row.eventKind)).map((row) => row.eventId);

const findIn = <Row>(ids: readonly unknown[], find: () => Promise<Row[]>) =>
  ids.length === 0 ? Promise.resolve([]) : find();

type ReviewFacts = { reviewId: string; count: number; lead: string | null };

async function reviewFacts(db: DetailDb, reviews: readonly { id: string; body: string | null }[]) {
  if (reviews.length === 0) return new Map<string, ReviewFacts>();
  const bare = reviews.filter((review) => !review.body).map((review) => review.id);
  const ids = Prisma.join(reviews.map((review) => Prisma.sql`${review.id}::uuid`));
  const leadOf = bare.length
    ? Prisma.sql`CASE WHEN c."reviewId" IN (${Prisma.join(bare.map((id) => Prisma.sql`${id}::uuid`))})
        THEN c."body" END`
    : Prisma.sql`NULL`;
  const rows = await db.$queryRaw<ReviewFacts[]>`
    SELECT DISTINCT ON (c."reviewId") c."reviewId", ${leadOf} AS "lead",
      (COUNT(*) OVER (PARTITION BY c."reviewId"))::int AS "count"
    FROM "artifact_comments" c
    WHERE c."reviewId" IN (${ids}) AND c."deletedAt" IS NULL
    ORDER BY c."reviewId", c."createdAt", c."id"`;
  return new Map(rows.map((row) => [row.reviewId, row]));
}

export async function artifactActivityDetails(
  db: DetailDb,
  workspaceId: string,
  rows: readonly ArtifactActivityRow[],
): Promise<Map<string, ArtifactActivityDetail>> {
  const commentIds = idsOf(rows, ["comment", "comment_edited"]);
  const reviewIds = idsOf(rows, ["review"]);
  const versionIds = idsOf(rows, ["version"]);
  const [artifacts, comments, reviews, versions, images] = await Promise.all([
    findIn(rows, () =>
      db.artifact.findMany({
        where: { id: { in: rows.map((row) => row.artifactId) }, workspaceId },
        select: { id: true, title: true, name: true, entryPath: true, currentVersion: true },
      }),
    ),
    findIn(commentIds, () =>
      db.artifactComment.findMany({
        where: { id: { in: commentIds } },
        select: {
          id: true,
          rootId: true,
          version: true,
          body: true,
          authorUserId: true,
          authorAgentId: true,
        },
      }),
    ),
    findIn(reviewIds, () =>
      db.artifactCommentReview.findMany({
        where: { id: { in: reviewIds } },
        select: { id: true, version: true, body: true, authorUserId: true, authorAgentId: true },
      }),
    ),
    findIn(versionIds, () =>
      db.artifactVersion.findMany({
        where: { id: { in: versionIds } },
        select: { id: true, number: true, publisherAgentId: true, publisherUserId: true },
      }),
    ),
    findIn(commentIds, () =>
      db.artifactCommentImage.groupBy({
        by: ["commentId"],
        where: { commentId: { in: commentIds } },
        _count: { _all: true },
      }),
    ),
  ]);
  const factsByReview = await reviewFacts(db, reviews);
  const artifactById = new Map(artifacts.map((row) => [row.id, row]));
  const commentById = new Map(comments.map((row) => [row.id, row]));
  const reviewRows = new Map(reviews.map((row) => [row.id, row]));
  const versionById = new Map(versions.map((row) => [row.id, row]));
  const imagesOf = new Map(images.map((row) => [row.commentId, row._count._all]));
  const details = new Map<string, ArtifactActivityDetail>();
  for (const row of rows) {
    const artifact = artifactById.get(row.artifactId);
    if (!artifact) continue;
    const at = (version: number) => (version === artifact.currentVersion ? null : version);
    const shown = {
      id: artifact.id,
      title: artifact.title,
      name: artifact.name,
      entryPath: artifact.entryPath,
    };
    const mentioned = row.latestMentions;
    const none = { imageCount: 0, reviewComments: null, version: null, preview: "" };
    const common = { artifact: shown, mentioned, kind: row.eventKind, ...none };
    if (row.eventKind === "version") {
      const version = versionById.get(row.eventId);
      if (!version) continue;
      details.set(row.artifactId, {
        ...common,
        authorUserId: version.publisherUserId,
        authorAgentId: version.publisherAgentId,
        version: version.number,
        target: { version: at(version.number), commentId: null, reviewId: null },
      });
    } else if (row.eventKind === "review") {
      const review = reviewRows.get(row.eventId);
      if (!review) continue;
      const facts = factsByReview.get(review.id);
      details.set(row.artifactId, {
        ...common,
        authorUserId: review.authorUserId,
        authorAgentId: review.authorAgentId,
        preview: oneLine(review.body || facts?.lead || ""),
        reviewComments: facts?.count ?? 0,
        target: { version: at(review.version), commentId: null, reviewId: review.id },
      });
    } else {
      const comment = commentById.get(row.eventId);
      if (!comment) continue;
      details.set(row.artifactId, {
        ...common,
        authorUserId: comment.authorUserId,
        authorAgentId: comment.authorAgentId,
        preview: oneLine(comment.body),
        imageCount: imagesOf.get(comment.id) ?? 0,
        target: {
          version: at(comment.version),
          commentId: comment.rootId ?? comment.id,
          reviewId: null,
        },
      });
    }
  }
  return details;
}
