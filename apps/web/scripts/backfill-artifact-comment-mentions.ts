import { requireDatabaseClient } from "../src/server/db/client.server";
import {
  insertMentionRows,
  peopleMentionedIn,
  type Mention,
} from "../src/server/artifacts/artifact-comment-mention-rows.server";

const argv = Bun.argv.slice(2);
const flag = (name: string) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};
const batchSize = Number(flag("--batch-size") ?? 500);
if (!Number.isInteger(batchSize) || batchSize < 1) throw new Error("--batch-size must be positive");
const apply = argv.includes("--apply");
if (apply === argv.includes("--dry-run"))
  throw new Error("usage: --dry-run | --apply [--from-id <uuid>] [--batch-size <n>]");

const db = requireDatabaseClient();
let after = flag("--from-id");
let comments = 0;
let reviews = 0;
let rows = 0;

async function backfillComment(id: string) {
  await db.$transaction(async (tx) => {
    const [locked] = await tx.$queryRaw<
      {
        id: string;
        body: string;
        authorUserId: string | null;
        createdAt: Date;
        artifactId: string;
      }[]
    >`SELECT "id", "body", "authorUserId", "createdAt", "artifactId" FROM "artifact_comments"
      WHERE "id" = ${id}::uuid AND "deletedAt" IS NULL FOR UPDATE`;
    if (!locked) return;
    const artifact = await tx.artifact.findUniqueOrThrow({
      where: { id: locked.artifactId },
      select: { workspaceId: true },
    });
    const [people] = await peopleMentionedIn(tx, artifact.workspaceId, [locked.body]);
    const mention: Mention = {
      target: { commentId: locked.id },
      people: people ?? [],
      at: locked.createdAt,
      authorUserId: locked.authorUserId,
    };
    rows += (await insertMentionRows(tx, locked.artifactId, [mention])).length;
  });
}

try {
  for (;;) {
    const batch = await db.artifactComment.findMany({
      where: { deletedAt: null, body: { contains: "@" }, ...(after ? { id: { gt: after } } : {}) },
      orderBy: { id: "asc" },
      take: batchSize,
      select: { id: true },
    });
    if (batch.length === 0) break;
    for (const { id } of batch) {
      comments += 1;
      if (apply) await backfillComment(id);
    }
    after = batch.at(-1)!.id;
    console.log(
      JSON.stringify({
        event: "backfill_artifact_comment_mentions",
        comments,
        rows,
        lastId: after,
      }),
    );
  }
  let reviewAfter: string | undefined;
  for (;;) {
    const batch = await db.artifactCommentReview.findMany({
      where: { body: { contains: "@" }, ...(reviewAfter ? { id: { gt: reviewAfter } } : {}) },
      orderBy: { id: "asc" },
      take: batchSize,
      select: {
        id: true,
        body: true,
        artifactId: true,
        authorUserId: true,
        createdAt: true,
        artifact: { select: { workspaceId: true } },
      },
    });
    if (batch.length === 0) break;
    reviews += batch.length;
    if (apply)
      for (const review of batch) {
        const [people] = await peopleMentionedIn(db, review.artifact.workspaceId, [
          review.body ?? "",
        ]);
        rows += (
          await insertMentionRows(db, review.artifactId, [
            {
              target: { reviewId: review.id },
              people: people ?? [],
              at: review.createdAt,
              authorUserId: review.authorUserId,
            },
          ])
        ).length;
      }
    reviewAfter = batch.at(-1)!.id;
    console.log(
      JSON.stringify({
        event: "backfill_artifact_review_mentions",
        reviews,
        rows,
        lastId: reviewAfter,
      }),
    );
  }
} finally {
  await db.$disconnect();
}
