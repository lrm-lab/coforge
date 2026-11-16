import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import type { CommentAnchor } from "#src/features/artifacts/artifact-comment-inputs";
import { AppError } from "#src/lib/app-error";
import { canResolveArtifactComment } from "./artifact-comment-access.server";
import {
  COMMENT_ORDER,
  cursorOf,
  formatCursor,
  parseCursor,
} from "./artifact-comment-unseen.server";
import { COMMENT_SELECT, commentViewPairs, type CommentRow } from "./artifact-comment-view.server";

export const THREADS_PAGE_SIZE = 20;

type Db = Pick<
  PrismaClient,
  "artifactComment" | "artifactCommentImage" | "workspaceMembership" | "agent" | "user"
>;

export type PersonAnchor = Omit<CommentAnchor, "data"> & { data: Record<string, string | number> };

type SharedView = Awaited<ReturnType<typeof commentViewPairs>>[number]["view"];

export type PersonCommentView = (
  | (Omit<Extract<SharedView, { body: string }>, "anchor"> & { anchor: PersonAnchor | null })
  | Extract<SharedView, { deleted: true }>
) & {
  authorId: string | null;
  mine: boolean;
  canResolve: boolean;
};

type ViewerPlace = {
  workspaceId: string;
  userId: string;
  artifact: { id: string; authorAgentId: string | null };
};

async function personViews(
  db: Db,
  input: ViewerPlace,
  rows: readonly CommentRow[],
): Promise<PersonCommentView[]> {
  const { workspaceId, userId, artifact } = input;
  const [pairs, managesAll] = await Promise.all([
    commentViewPairs(db, workspaceId, rows),
    canResolveArtifactComment(
      db,
      workspaceId,
      { userId },
      { artifact, root: { authorUserId: null, authorAgentId: null } },
    ),
  ]);
  return pairs.map(({ row, view }) => {
    const mine = row.authorUserId === userId;
    return {
      ...("deleted" in view ? view : { ...view, anchor: view.anchor as PersonAnchor | null }),
      authorId: row.authorAgentId ?? row.authorUserId,
      mine,
      canResolve: row.rootId === null && row.deletedAt === null && (mine || managesAll),
    };
  });
}

export async function commentsById(
  db: Db,
  input: ViewerPlace & { ids: readonly string[] },
): Promise<PersonCommentView[]> {
  const rows = await db.artifactComment.findMany({
    where: { artifactId: input.artifact.id, id: { in: [...input.ids] } },
    orderBy: [...COMMENT_ORDER],
    select: COMMENT_SELECT,
  });
  return personViews(db, input, rows);
}

export async function listThreads(db: Db, input: ViewerPlace & { before?: string | undefined }) {
  const { artifact } = input;
  const cursor = input.before === undefined ? null : parseCursor(input.before);
  if (input.before !== undefined && !cursor)
    throw new AppError("INVALID_INPUT", {
      errorId: "artifact-cursor",
      hint: "before takes the cursor the previous page named",
    });
  const earlier: Prisma.ArtifactCommentWhereInput = cursor
    ? { OR: [{ createdAt: { lt: cursor.at } }, { createdAt: cursor.at, id: { lt: cursor.id } }] }
    : {};
  const [roots, total] = await Promise.all([
    db.artifactComment.findMany({
      where: { artifactId: artifact.id, rootId: null, ...earlier },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: THREADS_PAGE_SIZE + 1,
      select: COMMENT_SELECT,
    }),
    cursor === null
      ? db.artifactComment.count({ where: { artifactId: artifact.id, deletedAt: null } })
      : undefined,
  ]);
  const page = roots.slice(0, THREADS_PAGE_SIZE);
  const replies = page.length
    ? await db.artifactComment.findMany({
        where: { artifactId: artifact.id, rootId: { in: page.map(({ id }) => id) } },
        orderBy: [...COMMENT_ORDER],
        select: COMMENT_SELECT,
      })
    : [];
  const alive = new Set(replies.filter((reply) => !reply.deletedAt).map((reply) => reply.rootId));
  const threads = page.filter((root) => !root.deletedAt || alive.has(root.id));
  const shownRoots = new Set(threads.map(({ id }) => id));
  const shown = [...threads, ...replies.filter((reply) => shownRoots.has(reply.rootId!))].sort(
    (left, right) =>
      left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id),
  );
  const last = page.at(-1);
  return {
    ...(total === undefined ? {} : { total }),
    comments: await personViews(db, input, shown),
    ...(roots.length > page.length && last ? { before: formatCursor(cursorOf(last)) } : {}),
  };
}
