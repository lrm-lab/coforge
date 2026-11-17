import { isRecord } from "#src/internal/json-record";

export const ARTIFACT_ANCHOR_TYPES = ["file", "lines", "element", "text", "page"] as const;

export type AgentArtifactAnchor = {
  type: (typeof ARTIFACT_ANCHOR_TYPES)[number];
  data: Record<string, unknown>;
};

export const COMMENT_BODY_MAX = 8000;
export const REVIEW_COMMENTS_MAX = 50;
export const ARTIFACT_COMMENT_IMAGES_MAX = 4;
export const ARTIFACT_REVIEW_IMAGES_MAX = 30;
export const ARTIFACT_COMMENT_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const ARTIFACT_COMMENT_IMAGE_MAX_PIXELS = 40_000_000;
export const ANCHOR_DATA_MAX_BYTES = 4096;

export type AgentReviewComment = {
  body: string;
  path?: string;
  anchor?: AgentArtifactAnchor;
  replyTo?: string;
  images?: string[];
};

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

const REVIEW_COMMENT_KEYS = ["body", "path", "anchor", "replyTo", "images"];

export function isReviewCommentShape(value: unknown): value is AgentReviewComment {
  if (!isRecord(value)) return false;
  if (typeof value.body !== "string") return false;
  if (!Object.keys(value).every((key) => REVIEW_COMMENT_KEYS.includes(key))) return false;
  if (value.path !== undefined && typeof value.path !== "string") return false;
  if (value.replyTo !== undefined && typeof value.replyTo !== "string") return false;
  if (
    value.images !== undefined &&
    !(
      Array.isArray(value.images) &&
      value.images.length <= ARTIFACT_COMMENT_IMAGES_MAX &&
      value.images.every((image) => typeof image === "string")
    )
  )
    return false;
  return value.anchor === undefined || isAnchorShape(value.anchor);
}
