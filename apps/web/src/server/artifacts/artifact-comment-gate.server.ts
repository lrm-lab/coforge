import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import { COMMENT_ORDER, commentPositionOf, unseenWhere } from "./artifact-comment-unseen.server";

/** How many comment ids a refusal lists; its `count` is of all of them. */
const IDS_LISTED = 10;

/** How many unseen comments the gate of a review reads to find the first comment it is about. */
const REVIEW_SCAN_LIMIT = 1000;

/** What an Agent is about to touch: the files it changes or comments on, and the threads it
 * answers. Comments on the whole artifact (no path) are always in the way. */
export type CommentScope = { paths: readonly string[]; threadIds: readonly string[] };

type GateDb = Pick<PrismaClient, "artifactComment" | "artifactCommentPosition">;

type UnseenRow = { id: string; path: string | null; rootId: string | null };

const isAbout = (scope: CommentScope, row: UnseenRow) =>
  row.path === null ||
  scope.paths.includes(row.path) ||
  scope.threadIds.includes(row.id) ||
  (row.rootId !== null && scope.threadIds.includes(row.rootId));

/**
 * Refuses with the gate's error while others commented, since the Agent's comment position, on
 * what any of `scopes` touches: a push (one scope of the files it changes), a comment (its file
 * and thread) or a review (one scope per comment, with `indexed`: the refusal then names the first
 * comment that clashes). Reads once, and counts only when the comments listed are not all of them.
 * Callers that must not race a comment write hold the comment lock.
 */
export async function requireNoUnseenComments(
  db: GateDb,
  input: {
    artifactId: string;
    agentId: string;
    scopes: readonly CommentScope[];
    indexed?: boolean;
  },
): Promise<void> {
  const { artifactId, agentId, scopes } = input;
  const position = await commentPositionOf(db, input);
  const paths = scopes.flatMap((scope) => scope.paths);
  const threadIds = scopes.flatMap((scope) => scope.threadIds);
  const where: Prisma.ArtifactCommentWhereInput = {
    AND: [
      unseenWhere({ artifactId, agentId, position }),
      {
        OR: [
          { path: null },
          ...(paths.length ? [{ path: { in: paths } }] : []),
          ...(threadIds.length ? [{ rootId: { in: threadIds } }, { id: { in: threadIds } }] : []),
        ],
      },
    ],
  };
  const limit = input.indexed ? REVIEW_SCAN_LIMIT : IDS_LISTED;
  const rows = await db.artifactComment.findMany({
    where,
    orderBy: [...COMMENT_ORDER],
    take: limit,
    select: { id: true, path: true, rootId: true },
  });
  if (rows.length === 0) return;
  const count = rows.length < limit ? rows.length : await db.artifactComment.count({ where });
  throw unseenCommentsRefusal(
    artifactId,
    { count, ids: rows.slice(0, IDS_LISTED).map((row) => row.id) },
    input.indexed
      ? scopes.findIndex((scope) => rows.some((row) => isAbout(scope, row)))
      : undefined,
  );
}

/**
 * The gate of an Agent's push: the files it adds or replaces and the paths it deletes (`touched`),
 * and the entry file it leaves and the one it opens at when it changes the entry; an entry-only
 * change touches no file but changes what the artifact opens at. A push that changes no file is
 * held up by whole-artifact comments alone.
 */
export function requireNoUnseenCommentsOnPush(
  db: GateDb,
  input: {
    artifactId: string;
    agentId: string;
    touched: readonly string[];
    entry: { current: string; pushed: string | undefined };
  },
) {
  const { current, pushed } = input.entry;
  return requireNoUnseenComments(db, {
    artifactId: input.artifactId,
    agentId: input.agentId,
    scopes: [
      {
        paths: [
          ...input.touched,
          ...(pushed !== undefined && pushed !== current ? [current, pushed] : []),
        ],
        threadIds: [],
      },
    ],
  });
}

/** The refusal: how many comments of others came since the Agent last read them, and which. */
function unseenCommentsRefusal(
  artifactId: string,
  unseen: { count: number; ids: string[] },
  index?: number,
) {
  const many = unseen.count === 1 ? "1 comment" : `${unseen.count} comments`;
  return new AppError("CONFLICT", {
    errorId: "artifact-unseen-comments",
    details: {
      count: unseen.count,
      commentIds: unseen.ids.join(","),
      ...(index === undefined ? {} : { index }),
    },
    hint: `${many} from others, new since you last read comments and about what this touches${
      index === undefined ? "" : ` (first: comments[${index}])`
    }: read ${unseen.count === 1 ? "it" : "them"} with \`coforge artifact comments ${artifactId}\`, then send this again`,
  });
}
