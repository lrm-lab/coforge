import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import type { ArtifactActorName } from "./artifact-actor-names.server";
import {
  COMMENT_SELECT,
  commentViews,
  type ArtifactCommentView,
} from "./artifact-comment-view.server";
import { COMMENT_ORDER, commentPositionOf, unseenWhere } from "./artifact-comment-unseen.server";

const FULL_COMMENTS_MAX = 5;
const FULL_CHARS_MAX = 8000;
const EXCERPTS_MAX = 5;
const EXCERPT_CHARS = 200;

type BlockDb = Pick<
  PrismaClient,
  "artifactComment" | "artifactCommentPosition" | "artifactCommentImage" | "agent" | "user"
>;

export type UnseenExcerpt = {
  id: string;
  author: ArtifactActorName;
  path: string | null;
  version: number;
  createdAt: Date;
  excerpt: string;
};

export type UnseenCommentBlock = {
  count: number;
  comments: ArtifactCommentView[];
  excerpts: UnseenExcerpt[];
  unread: number;
  seenThrough: string | null;
  skipped: number;
};

const before = (row: { createdAt: Date; id: string }): Prisma.ArtifactCommentWhereInput => ({
  OR: [{ createdAt: { lt: row.createdAt } }, { createdAt: row.createdAt, id: { lt: row.id } }],
});

export async function unseenCommentBlock(
  db: BlockDb,
  input: {
    workspaceId: string;
    artifactId: string;
    agentId: string;
    about?: Prisma.ArtifactCommentWhereInput;
  },
): Promise<UnseenCommentBlock> {
  const { workspaceId, artifactId, agentId, about } = input;
  const unseen = unseenWhere({
    artifactId,
    agentId,
    position: await commentPositionOf(db, { artifactId, agentId }),
  });
  const where: Prisma.ArtifactCommentWhereInput = about ? { AND: [unseen, about] } : unseen;
  const take = FULL_COMMENTS_MAX + EXCERPTS_MAX;
  const rows = await db.artifactComment.findMany({
    where,
    orderBy: [...COMMENT_ORDER],
    take,
    select: COMMENT_SELECT,
  });
  const count = rows.length < take ? rows.length : await db.artifactComment.count({ where });
  const views = (await commentViews(db, workspaceId, rows)).filter(
    (view): view is ArtifactCommentView => "body" in view,
  );
  let chars = 0;
  let full = 0;
  while (full < Math.min(views.length, FULL_COMMENTS_MAX)) {
    chars += views[full]!.body.length;
    if (chars > FULL_CHARS_MAX) break;
    full += 1;
  }
  const comments = views.slice(0, full);
  const unread = count - full;
  const excerpts = views.slice(full, full + EXCERPTS_MAX).map((view) => ({
    id: view.id,
    author: view.author,
    path: view.path,
    version: view.version,
    createdAt: view.createdAt,
    excerpt: view.body.replace(/\s+/g, " ").trim().slice(0, EXCERPT_CHARS),
  }));
  const firstUnread = rows[full];
  const reached =
    unread > 0 && about && firstUnread
      ? await db.artifactComment.findFirst({
          where: { AND: [unseen, before(firstUnread)] },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          select: { id: true, createdAt: true },
        })
      : (rows[full - 1] ?? null);
  const skipped =
    about && reached
      ? await db.artifactComment.count({
          where: {
            AND: [unseen, { NOT: about }, { OR: [before(reached), { id: reached.id }] }],
          },
        })
      : 0;
  return { count, comments, excerpts, unread, seenThrough: reached?.id ?? null, skipped };
}
