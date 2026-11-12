import type { AgentArtifactRequest } from "@lrm/coforge-sdk/agent";
import { isRecord } from "@lrm/coforge-sdk/internal";
import {
  commentIdOf,
  linesAnchor,
  type ArtifactCommentDraft,
  type ArtifactCommentInvocation,
} from "#src/artifact-comment-args";
import {
  formatComments,
  formatPostedComment,
  formatPostedReview,
  formatReopened,
  formatResolved,
  type CommentAnswer,
  type CommentsAnswer,
  type PostedReviewAnswer,
  type ResolvedAnswer,
} from "#src/artifact-comment-format";
import { CliError, invalidArg, withOutputMode } from "#src/cli-error";

type ReviewRequest = Extract<AgentArtifactRequest, { operation: "review" }>;
type ReviewComment = ReviewRequest["comments"][number];

/**
 * Sends one comment operation and says what came of it. A comment's words, and a review's JSON,
 * are read from stdin (`readStdin`) before anything is sent; a retry of a lost response is a
 * new request with a new key, so the writes name what may have landed (`artifactRequest`).
 */
export async function runArtifactComment(
  invocation: ArtifactCommentInvocation,
  transport: { artifact?: (request: AgentArtifactRequest) => Promise<unknown> },
  readStdin: () => Promise<string>,
): Promise<unknown> {
  if (!transport.artifact) throw new Error("Artifact transport is unavailable");
  const json = invocation.json === true;
  const draft = invocation.comment;
  const request = await buildRequest(draft, readStdin);
  const result = await transport.artifact(request).catch((error: unknown) => {
    throw error instanceof CliError ? withOutputMode(error, json ? "json" : "text") : error;
  });
  if (json) return result;
  switch (draft.operation) {
    case "comments":
      return formatComments(result as CommentsAnswer, draft);
    case "comment":
      return formatPostedComment(result as CommentAnswer);
    case "review":
      return formatPostedReview(result as PostedReviewAnswer);
    case "resolve":
      return formatResolved(result as ResolvedAnswer);
    case "reopen":
      return formatReopened(result as ResolvedAnswer);
  }
}

async function buildRequest(
  draft: ArtifactCommentDraft,
  readStdin: () => Promise<string>,
): Promise<AgentArtifactRequest> {
  switch (draft.operation) {
    case "comments":
    case "resolve":
    case "reopen":
      return draft;
    case "comment": {
      const body = (await readStdin()).trim();
      if (!body)
        throw invalidArg(
          "Write the comment on stdin, for example with a quoted here-document (<<'EOF')",
        );
      return { ...draft, body, idempotencyKey: crypto.randomUUID() };
    }
    case "review": {
      const { body, comments } = parseReview(await readStdin());
      return {
        ...draft,
        ...(body === undefined ? {} : { body }),
        comments,
        idempotencyKey: crypto.randomUUID(),
      };
    }
  }
}

/** A review's JSON: `{ body?, comments: [...] }` or the bare array of comments. The server judges
 * every field; only the `lines` shorthand of a comment and the `c_` of a `replyTo` are changed. */
function parseReview(text: string): Pick<ReviewRequest, "body" | "comments"> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw invalidArg(
      'The review on stdin is not JSON: send { "body": "...", "comments": [{ "body": "...", "path": "a.md", "lines": "3-4" }] } or just the array of comments',
    );
  }
  const container = Array.isArray(parsed) ? { comments: parsed } : parsed;
  if (!isRecord(container) || !Array.isArray(container.comments))
    throw invalidArg('The review needs comments: an array, or { "comments": [...] }');
  return {
    ...(container.body === undefined ? {} : { body: container.body as ReviewRequest["body"] }),
    comments: container.comments.map(reviewComment),
  };
}

/** One comment of a review as the server takes it; `lines` (`N` or `a-b`) is the shorthand for a
 * `lines` anchor, and a `replyTo` may carry the `c_` it was printed with. */
function reviewComment(value: unknown, index: number): ReviewComment {
  if (!isRecord(value)) return value as ReviewComment;
  const { lines, replyTo, ...rest } = value;
  let anchor = rest.anchor;
  if (lines !== undefined) {
    if (anchor !== undefined)
      throw invalidArg(`comments[${index}]: give an anchor or lines, not both`);
    anchor = linesAnchor(String(lines));
    if (!anchor)
      throw invalidArg(`comments[${index}]: lines takes a line N or a range a-b, not "${lines}"`);
  }
  return {
    ...rest,
    ...(anchor === undefined ? {} : { anchor }),
    ...(replyTo === undefined
      ? {}
      : { replyTo: typeof replyTo === "string" ? commentIdOf(replyTo) : replyTo }),
  } as ReviewComment;
}
