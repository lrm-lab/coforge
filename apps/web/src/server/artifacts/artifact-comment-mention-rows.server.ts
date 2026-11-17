import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import { COMMENT_HANDLES_RESOLVED_MAX } from "#src/features/artifacts/artifact-comment-inputs";
import { peopleReadingArtifact, type ArtifactAccessRow } from "./artifact-access.server";
import type { CommentRow, ReviewRow } from "./artifact-comment-view.server";
import { startFollowing } from "./artifact-follows.server";
import {
  mentionHandles,
  peopleNamed,
  type MentionedPerson,
} from "./artifact-notice-mentions.server";

type MentionDb = Pick<PrismaClient, "workspaceMembership">;
type MentionTx = Pick<
  Prisma.TransactionClient,
  "artifactCommentMention" | "workspaceMembership" | "conversation" | "agent" | "$executeRaw"
>;

export type MentionTarget = { commentId: string } | { reviewId: string };

export type Mention = {
  target: MentionTarget;
  people: readonly MentionedPerson[];
  at: Date;
  authorUserId: string | null;
};

export type Mentioned = { userId: string; at: Date }[];

type Place = { workspaceId: string; artifact: ArtifactAccessRow & { id: string } };

export async function peopleMentionedIn(
  db: MentionDb,
  workspaceId: string,
  texts: readonly string[],
): Promise<MentionedPerson[][]> {
  const handlesOf = texts.map(
    (text) => new Set(mentionHandles(text, COMMENT_HANDLES_RESOLVED_MAX)),
  );
  const people = await peopleNamed(db, workspaceId, [
    ...new Set(handlesOf.flatMap((handles) => [...handles])),
  ]);
  return handlesOf.map((handles) => people.filter((person) => handles.has(person.username)));
}

export const commentMentions = (
  rows: readonly CommentRow[],
  people: readonly (readonly MentionedPerson[])[],
  offset = 0,
): Mention[] =>
  rows.map((row, index) => ({
    target: { commentId: row.id },
    people: people[index + offset]!,
    at: row.createdAt,
    authorUserId: row.authorUserId,
  }));

export const reviewMentions = (
  review: ReviewRow,
  rows: readonly CommentRow[],
  people: readonly (readonly MentionedPerson[])[],
): Mention[] => [
  {
    target: { reviewId: review.id },
    people: people[0]!,
    at: review.createdAt,
    authorUserId: review.authorUserId,
  },
  ...commentMentions(rows, people, 1),
];

const rowsOf = (artifactId: string, mention: Mention) =>
  mention.people
    .filter((person) => person.id !== mention.authorUserId)
    .map((person) => ({
      artifactId,
      userId: person.id,
      mentionedAt: mention.at,
      ...mention.target,
    }));

async function followReaders(tx: MentionTx, place: Place, mentioned: Mentioned) {
  const readers = await peopleReadingArtifact(
    tx,
    place.workspaceId,
    place.artifact,
    mentioned.map(({ userId }) => userId),
  );
  await startFollowing(
    tx,
    place.artifact.id,
    mentioned.filter(({ userId }) => readers.has(userId)),
  );
  return mentioned.filter(({ userId }) => readers.has(userId)).map(({ userId }) => userId);
}

const earliestPerPerson = (rows: readonly { userId: string; mentionedAt: Date }[]): Mentioned => {
  const first = new Map<string, Date>();
  for (const { userId, mentionedAt } of rows) {
    const earlier = first.get(userId);
    if (!earlier || mentionedAt < earlier) first.set(userId, mentionedAt);
  }
  return [...first].map(([userId, at]) => ({ userId, at }));
};

export async function insertMentionRows(
  db: Pick<Prisma.TransactionClient, "artifactCommentMention">,
  artifactId: string,
  mentions: readonly Mention[],
) {
  const rows = mentions.flatMap((mention) => rowsOf(artifactId, mention));
  if (rows.length > 0)
    await db.artifactCommentMention.createMany({ data: rows, skipDuplicates: true });
  return rows;
}

export async function writeMentions(
  tx: MentionTx,
  place: Place,
  mentions: readonly Mention[],
): Promise<string[]> {
  const rows = await insertMentionRows(tx, place.artifact.id, mentions);
  return rows.length === 0 ? [] : followReaders(tx, place, earliestPerPerson(rows));
}

export async function rewriteMentions(
  tx: MentionTx,
  place: Place,
  edit: {
    commentId: string;
    people: readonly MentionedPerson[];
    editedAt: Date;
    authorUserId: string;
  },
): Promise<{ followed: string[]; removed: string[] }> {
  const held = await tx.artifactCommentMention.findMany({
    where: { commentId: edit.commentId },
    select: { userId: true },
  });
  const named = new Set(
    edit.people.filter((person) => person.id !== edit.authorUserId).map((person) => person.id),
  );
  const before = new Set(held.map((row) => row.userId));
  const removed = [...before].filter((userId) => !named.has(userId));
  const added = edit.people.filter((person) => named.has(person.id) && !before.has(person.id));
  if (removed.length > 0)
    await tx.artifactCommentMention.deleteMany({
      where: { commentId: edit.commentId, userId: { in: removed } },
    });
  const followed = await writeMentions(tx, place, [
    {
      target: { commentId: edit.commentId },
      people: added,
      at: edit.editedAt,
      authorUserId: edit.authorUserId,
    },
  ]);
  return { followed, removed };
}

export async function removeMentions(tx: MentionTx, commentId: string): Promise<string[]> {
  const held = await tx.artifactCommentMention.findMany({
    where: { commentId },
    select: { userId: true },
  });
  if (held.length > 0) await tx.artifactCommentMention.deleteMany({ where: { commentId } });
  return held.map((row) => row.userId);
}
