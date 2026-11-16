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
import type { ArtifactDirectoryTransport } from "#src/artifact-directory-args";
import {
  COMMENT_IMAGES_MAX,
  REVIEW_IMAGES_MAX,
  requireImageCount,
  uploadImage,
} from "#src/artifact-images";
import { CliError, invalidArg, withOutputMode } from "#src/cli-error";

type ReviewRequest = Extract<AgentArtifactRequest, { operation: "review" }>;
type ReviewComment = ReviewRequest["comments"][number];

export async function runArtifactComment(
  invocation: ArtifactCommentInvocation,
  transport: Pick<ArtifactDirectoryTransport, "artifact" | "artifactUpload">,
  readStdin: () => Promise<string>,
): Promise<unknown> {
  if (!transport.artifact) throw new Error("Artifact transport is unavailable");
  const json = invocation.json === true;
  const draft = invocation.comment;
  const request = await buildRequest(draft, readStdin, transport);
  const result = await transport.artifact(request).catch((error: unknown) => {
    throw error instanceof CliError ? withOutputMode(error, json ? "json" : "text") : error;
  });
  if (json) return result;
  switch (draft.operation) {
    case "comments":
      return formatComments(result as CommentsAnswer, draft);
    case "comment":
      return formatPostedComment(result as CommentAnswer, draft.artifact);
    case "review":
      return formatPostedReview(result as PostedReviewAnswer, draft.artifact);
    case "resolve":
      return formatResolved(result as ResolvedAnswer, draft.artifact);
    case "reopen":
      return formatReopened(result as ResolvedAnswer);
  }
}

async function buildRequest(
  draft: ArtifactCommentDraft,
  readStdin: () => Promise<string>,
  transport: Pick<ArtifactDirectoryTransport, "artifactUpload">,
): Promise<AgentArtifactRequest> {
  switch (draft.operation) {
    case "comments":
    case "resolve":
    case "reopen":
      return draft;
    case "comment": {
      const { imagePaths = [], ...rest } = draft;
      requireImageCount(imagePaths.length, COMMENT_IMAGES_MAX, "a comment");
      const body = (await readStdin()).trim();
      if (!body && imagePaths.length === 0)
        throw invalidArg(
          "Write the comment on stdin, for example with a quoted here-document (<<'EOF'), or attach an image with --image <path>",
        );
      const images = await Promise.all(imagePaths.map((path) => uploadImage(transport, path)));
      return {
        ...rest,
        ...(body ? { body } : {}),
        ...(images.length > 0 ? { images } : {}),
        idempotencyKey: crypto.randomUUID(),
      };
    }
    case "review": {
      const { body, comments } = parseReview(await readStdin());
      const total = comments.reduce(
        (sum, comment) => sum + (Array.isArray(comment.images) ? comment.images.length : 0),
        0,
      );
      requireImageCount(total, REVIEW_IMAGES_MAX, "a review");
      for (const [index, comment] of comments.entries())
        requireImageCount(
          Array.isArray(comment.images) ? comment.images.length : 0,
          COMMENT_IMAGES_MAX,
          `comments[${index}]`,
        );
      const uploaded = await Promise.all(
        comments.map(async (comment) =>
          Array.isArray(comment.images)
            ? {
                ...comment,
                images: await Promise.all(
                  comment.images.map((path) => uploadImage(transport, String(path))),
                ),
              }
            : comment,
        ),
      );
      return {
        ...draft,
        ...(body === undefined ? {} : { body }),
        comments: uploaded,
        idempotencyKey: crypto.randomUUID(),
      };
    }
  }
}

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
