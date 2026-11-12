import { shellWord } from "#src/artifact-directory";
import { plural } from "#src/plural";
import {
  foldUntrustedLine,
  formatUtcTimestamp,
  MESSAGE_LINE_SEPARATOR,
} from "@lrm/coforge-sdk/internal";

/** What `coforge artifact comments|comment|review|resolve|reopen` print. The shapes are the
 * server's answers. */

type Actor = { kind: "user" | "agent"; name: string };

export type CommentAnswer = {
  id: string;
  author: Actor;
  version: number;
  path: string | null;
  anchor?: { type: string; data: Record<string, unknown> } | null;
  replyTo: string | null;
  body?: string;
  createdAt: string;
  reviewId: string | null;
  resolvedAt: string | null;
  resolvedBy: Actor | null;
  deleted?: true;
};

type ReviewAnswer = { id: string; author: Actor; version: number; body: string | null };

/** The answer to `review`: the review and its comments, in the order written. */
export type PostedReviewAnswer = { review: ReviewAnswer; comments: CommentAnswer[] };

/** The answer to `resolve` and `reopen`: the thread's first comment, whether anything changed, and
 * the note posted before it closed. */
export type ResolvedAnswer = { comment: CommentAnswer; changed: boolean; note?: CommentAnswer };

export type CommentsAnswer = {
  view: "unseen" | "all";
  comments: CommentAnswer[];
  nextCursor?: string;
  unseenVersionCount: number;
  review?: ReviewAnswer;
};

/** An unseen comment as a read of the artifact excerpts it. */
export type UnseenCommentAnswer = {
  id: string;
  author: Actor;
  path: string | null;
  createdAt: string;
  excerpt: string;
};

/** The comments of others the Agent has not read, as a read of the artifact says it: how many, and
 * the newest few. */
export type UnseenCommentsAnswer = { count: number; comments: UnseenCommentAnswer[] };

/** The flags of the `comments` request a page came from, for the command of the next page. */
export type CommentsRequest = { artifact: string; path?: string; all?: boolean; review?: string };

const commentId = (id: string) => `c_${id}`;
const name = (actor: Actor) => `@${foldUntrustedLine(actor.name)}`;
const QUOTE_SHOWN = 40;

/** The lines or place a comment points at, after its file: `plan.md:3-4`, `plan.md`. */
function whereOf(path: string | null, anchor: CommentAnswer["anchor"]): string {
  if (path === null) return "";
  const file = foldUntrustedLine(path);
  const data = anchor?.data ?? {};
  if (anchor?.type === "lines" && typeof data.start === "number") {
    const end = typeof data.end === "number" && data.end !== data.start ? `-${data.end}` : "";
    return `${file}:${data.start}${end}`;
  }
  if (anchor?.type === "element" && typeof data.selector === "string")
    return `${file} (element ${foldUntrustedLine(data.selector)})`;
  if (anchor?.type === "text" && typeof data.quote === "string") {
    const quote = foldUntrustedLine(data.quote);
    return `${file} ("${quote.length > QUOTE_SHOWN ? `${quote.slice(0, QUOTE_SHOWN)}…` : quote}")`;
  }
  return file;
}

/** A body's lines under an indent, every line after the first behind the gutter so none passes for
 * a header of its own. */
function body(text: string, indent: string): string[] {
  return text
    .split(MESSAGE_LINE_SEPARATOR)
    .map((line, index) => (index === 0 ? `${indent}${line}` : `${indent}│ ${line}`));
}

function entry(comment: CommentAnswer, indent: string, withRoot: boolean): string[] {
  const where = whereOf(comment.path, comment.anchor);
  const reply = withRoot && comment.replyTo ? `reply in ${commentId(comment.replyTo)}` : "";
  const place = [where, reply].filter(Boolean).join(", ");
  const marks = [
    comment.deleted ? "deleted" : "",
    comment.resolvedAt
      ? `resolved${comment.resolvedBy ? ` by ${name(comment.resolvedBy)}` : ""}, ${formatUtcTimestamp(comment.resolvedAt)}`
      : "",
  ].filter(Boolean);
  const header =
    `${indent}${commentId(comment.id)} ${name(comment.author)} v${comment.version}` +
    `${place ? ` ${place}` : ""} (${formatUtcTimestamp(comment.createdAt)})` +
    (marks.length ? ` [${marks.join("] [")}]` : "");
  return [
    header,
    ...(comment.deleted || comment.body === undefined ? [] : body(comment.body, `${indent}  `)),
  ];
}

/** The comments of a page as threads: a first comment, its replies beneath it. A reply whose first
 * comment is not on the page stands alone and says which thread it is in. */
export function formatComments(answer: CommentsAnswer, request: CommentsRequest): string {
  const { comments } = answer;
  const lines: string[] = [];
  if (answer.review)
    lines.push(
      `Review ${answer.review.id} by ${name(answer.review.author)} (version ${answer.review.version})${answer.review.body ? `: ${foldUntrustedLine(answer.review.body)}` : ""}`,
    );
  if (comments.length === 0)
    lines.push(answer.view === "unseen" ? "No new comments from others." : "No comments yet.");
  else
    lines.push(
      answer.view === "unseen"
        ? `${plural(comments.length, "new comment")} from others, oldest first.`
        : `${plural(comments.length, "comment")}.`,
    );
  const onPage = new Set(comments.map((comment) => comment.id));
  for (const comment of comments) {
    const underRoot = comment.replyTo !== null && onPage.has(comment.replyTo);
    if (underRoot) continue;
    lines.push(...entry(comment, "", true));
    for (const reply of comments)
      if (reply.replyTo === comment.id) lines.push(...entry(reply, "  ", false));
  }
  if (answer.nextCursor) lines.push(`More: ${nextPage(request, answer)}`);
  if (answer.unseenVersionCount > 0)
    lines.push(
      `${plural(answer.unseenVersionCount, "version")} of others came since you last read the artifact: coforge artifact read ${request.artifact}`,
    );
  if (comments.length > 0)
    lines.push(
      `Reply: coforge artifact comment ${request.artifact} --reply-to <comment id> | Resolve: coforge artifact resolve ${request.artifact} <comment id>`,
    );
  return lines.join("\n");
}

/** The next page's command: an unfiltered unseen read just goes on from where it moved to; any
 * other names the cursor. */
function nextPage(request: CommentsRequest, answer: CommentsAnswer): string {
  const base = `coforge artifact comments ${request.artifact}`;
  if (answer.view === "unseen" && request.path === undefined) return base;
  return [
    base,
    ...(request.path === undefined ? [] : [`--path ${shellWord(request.path)}`]),
    ...(request.all ? ["--all"] : []),
    ...(request.review === undefined ? [] : [`--review ${shellWord(request.review)}`]),
    `--after ${shellWord(answer.nextCursor ?? "")}`,
  ].join(" ");
}

const whereOrArtifact = (comment: CommentAnswer) =>
  whereOf(comment.path, comment.anchor) || "the whole artifact";

export function formatPostedComment(comment: CommentAnswer): string {
  const thread = comment.replyTo ? ` as a reply in ${commentId(comment.replyTo)}` : "";
  return `Posted ${commentId(comment.id)}${thread} on ${whereOrArtifact(comment)} (version ${comment.version}).`;
}

export function formatPostedReview(answer: PostedReviewAnswer): string {
  return [
    `Posted review ${answer.review.id} with ${plural(answer.comments.length, "comment")} (version ${answer.review.version}).`,
    ...answer.comments.map(
      (comment) => `  ${commentId(comment.id)} on ${whereOrArtifact(comment)}`,
    ),
  ].join("\n");
}

export function formatResolved(answer: ResolvedAnswer): string {
  const id = commentId(answer.comment.id);
  if (!answer.changed) return `The thread ${id} was already resolved: nothing changed.`;
  return answer.note
    ? `Posted your note ${commentId(answer.note.id)}, then resolved the thread ${id}.`
    : `Resolved the thread ${id}.`;
}

export function formatReopened(answer: ResolvedAnswer): string {
  const id = commentId(answer.comment.id);
  return answer.changed
    ? `Reopened the thread ${id}.`
    : `The thread ${id} was already open: nothing changed.`;
}

/** What `read` and `pull` print of the comments others wrote since the Agent last read them: a
 * headline with the command that reads them, the newest as excerpts, and how many are left out. */
export function formatUnseenComments(
  artifact: string,
  unseen: UnseenCommentsAnswer | null | undefined,
): string[] {
  if (!unseen || unseen.count === 0) return [];
  const { count, comments } = unseen;
  const earlier = count - comments.length;
  return [
    `${plural(count, "new comment")} from others (read ${count === 1 ? "it" : "them"}: coforge artifact comments ${artifact}), newest first:`,
    ...comments.map(
      (comment) =>
        `- ${commentId(comment.id)} ${name(comment.author)}${comment.path === null ? "" : ` ${foldUntrustedLine(comment.path)}`}, ${formatUtcTimestamp(comment.createdAt)}: ${foldUntrustedLine(comment.excerpt)}`,
    ),
    ...(earlier > 0 ? [`- … ${earlier} earlier`] : []),
  ];
}
