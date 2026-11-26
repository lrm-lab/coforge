import { z } from "zod";

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
  body?: string;
  path?: string;
  anchor?: AgentArtifactAnchor;
  replyTo?: string;
  images?: string[];
};

const anchorSchema = z.strictObject({
  type: z.enum(ARTIFACT_ANCHOR_TYPES),
  data: z.record(z.string(), z.unknown()),
});

const reviewCommentSchema = z
  .strictObject({
    body: z.string().optional(),
    path: z.string().optional(),
    anchor: anchorSchema.optional(),
    replyTo: z.string().optional(),
    images: z.array(z.string()).max(ARTIFACT_COMMENT_IMAGES_MAX).optional(),
  })
  .refine(
    (value) =>
      (value.body !== undefined && value.body.length > 0) ||
      (value.images !== undefined && value.images.length > 0),
  );

export function isAnchorShape(value: unknown): value is AgentArtifactAnchor {
  return anchorSchema.safeParse(value).success;
}

export function isReviewCommentShape(value: unknown): value is AgentReviewComment {
  return reviewCommentSchema.safeParse(value).success;
}
