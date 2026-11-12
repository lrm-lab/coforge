import { isRecord } from "#src/internal/json-record";

/**
 * The comment operations of `POST /api/agent/v1/artifacts`: what an anchor and a review's comment
 * look like on the wire. The decoder checks only the shape, with no stray key at any level; the
 * server judges the values (limits, the anchor's data, the paths).
 */

/** The kinds of place a comment points at in a file. */
export const ARTIFACT_ANCHOR_TYPES = ["file", "lines", "element", "text"] as const;

/** Where in a file a comment points: a whole `file`, `lines` (`{ start, end }`, 1-based), an
 * `element` (`{ selector, quote? }`) or a `text` selection (`{ quote, prefix?, suffix? }`). */
export type AgentArtifactAnchor = {
  type: (typeof ARTIFACT_ANCHOR_TYPES)[number];
  data: Record<string, unknown>;
};

/** The most characters a comment's text has. */
export const COMMENT_BODY_MAX = 8000;
/** The most comments one review carries. */
export const REVIEW_COMMENTS_MAX = 50;
/** The most an anchor's `data` may weigh, as JSON. */
export const ANCHOR_DATA_MAX_BYTES = 4096;

/** One comment of a review: a comment's own fields. */
export type AgentReviewComment = {
  body: string;
  path?: string;
  anchor?: AgentArtifactAnchor;
  replyTo?: string;
};

/** An anchor is exactly `{ type, data }`: `type` one of `ARTIFACT_ANCHOR_TYPES`, `data` an object. */
export function isAnchorShape(value: unknown): value is AgentArtifactAnchor {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  return (
    keys.length === 2 &&
    keys.includes("type") &&
    keys.includes("data") &&
    (ARTIFACT_ANCHOR_TYPES as readonly unknown[]).includes(value.type) &&
    isRecord(value.data)
  );
}

const REVIEW_COMMENT_KEYS = ["body", "path", "anchor", "replyTo"];

/** A review's comment: `body`, and optionally `path`, `anchor` and `replyTo`. */
export function isReviewCommentShape(value: unknown): value is AgentReviewComment {
  if (!isRecord(value)) return false;
  if (typeof value.body !== "string") return false;
  if (!Object.keys(value).every((key) => REVIEW_COMMENT_KEYS.includes(key))) return false;
  if (value.path !== undefined && typeof value.path !== "string") return false;
  if (value.replyTo !== undefined && typeof value.replyTo !== "string") return false;
  return value.anchor === undefined || isAnchorShape(value.anchor);
}
