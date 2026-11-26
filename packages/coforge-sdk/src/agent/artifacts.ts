import { z } from "zod";
import { isArtifactCheckShot, type ArtifactCheckShot } from "./artifact-checks";
import {
  ARTIFACT_COMMENT_IMAGES_MAX,
  isAnchorShape,
  isReviewCommentShape,
  type AgentArtifactAnchor,
  type AgentReviewComment,
} from "./artifact-comments";

export const ARTIFACT_REQUEST_MAX_BYTES = 4 * 1024 * 1024;

export const ARTIFACT_UPLOAD_MAX_BYTES = 16 * 1024 * 1024;

export type AgentArtifactFile = { path: string; sha256: string };

export type AgentArtifactRequest =
  | { operation: "list"; target?: string; query?: string; after?: string; limit?: number }
  | { operation: "read"; artifact: string; version?: number }
  | { operation: "check"; artifact: string; version?: number }
  | { operation: "check-shot"; artifact: string; version?: number; shot: ArtifactCheckShot }
  | {
      operation: "push";
      artifact: string;
      baseVersion: number;
      idempotencyKey: string;
      title?: string;
      description?: string;
      note?: string;
      label?: string;
      files?: AgentArtifactFile[];
      delete?: string[];
      entry?: string;
    }
  | {
      operation: "push";
      artifact?: undefined;
      target?: string;
      title: string;
      description?: string;
      idempotencyKey: string;
      files: AgentArtifactFile[];
      entry?: string;
    }
  | {
      operation: "comments";
      artifact: string;
      path?: string;
      all?: boolean;
      review?: string;
      after?: string;
    }
  | {
      operation: "comment";
      artifact: string;
      body?: string;
      path?: string;
      anchor?: AgentArtifactAnchor;
      replyTo?: string;
      version?: number;
      images?: string[];
      idempotencyKey: string;
    }
  | {
      operation: "review";
      artifact: string;
      body?: string;
      comments: AgentReviewComment[];
      version?: number;
      idempotencyKey: string;
    }
  | {
      operation: "move";
      artifact: string;
      to: string;
    }
  | { operation: "delete"; artifact: string }
  | { operation: "save"; attachment: string }
  | { operation: "image"; artifact: string; image: string }
  | { operation: "resolve"; artifact: string; comment: string; note?: string }
  | { operation: "reopen"; artifact: string; comment: string }
  | { operation: "follow"; artifact: string }
  | { operation: "unfollow"; artifact: string };

export const ARTIFACT_SHA256_PATTERN = /^[0-9a-f]{64}$/;

const nonNegativeSafeInt = z.int().min(0);
const sha256Schema = z.string().regex(ARTIFACT_SHA256_PATTERN);
const sha256ListSchema = z.array(sha256Schema).max(ARTIFACT_COMMENT_IMAGES_MAX);
const manifestFileSchema = z.strictObject({
  path: z.string(),
  sha256: sha256Schema,
});
const anchorFieldSchema = z.custom<AgentArtifactAnchor>(isAnchorShape);
const reviewCommentFieldSchema = z.custom<AgentReviewComment>(isReviewCommentShape);
const checkShotFieldSchema = z.custom<ArtifactCheckShot>(isArtifactCheckShot);

const agentArtifactRequestSchema = z.union([
  z.strictObject({
    operation: z.literal("list"),
    target: z.string().exactOptional(),
    query: z.string().exactOptional(),
    after: z.string().exactOptional(),
    limit: nonNegativeSafeInt.exactOptional(),
  }),
  z.strictObject({
    operation: z.literal("read"),
    artifact: z.string(),
    version: nonNegativeSafeInt.exactOptional(),
  }),
  z.strictObject({
    operation: z.literal("check"),
    artifact: z.string(),
    version: nonNegativeSafeInt.exactOptional(),
  }),
  z.strictObject({
    operation: z.literal("check-shot"),
    artifact: z.string(),
    version: nonNegativeSafeInt.exactOptional(),
    shot: checkShotFieldSchema,
  }),
  z.strictObject({
    operation: z.literal("push"),
    artifact: z.string(),
    baseVersion: nonNegativeSafeInt,
    idempotencyKey: z.string(),
    title: z.string().exactOptional(),
    description: z.string().exactOptional(),
    note: z.string().exactOptional(),
    label: z.string().exactOptional(),
    files: z.array(manifestFileSchema).exactOptional(),
    delete: z.array(z.string()).exactOptional(),
    entry: z.string().exactOptional(),
  }),
  z.strictObject({
    operation: z.literal("push"),
    target: z.string().exactOptional(),
    title: z.string(),
    description: z.string().exactOptional(),
    idempotencyKey: z.string(),
    files: z.array(manifestFileSchema),
    entry: z.string().exactOptional(),
  }),
  z.strictObject({
    operation: z.literal("move"),
    artifact: z.string(),
    to: z.string(),
  }),
  z.strictObject({
    operation: z.literal("delete"),
    artifact: z.string(),
  }),
  z.strictObject({
    operation: z.literal("comments"),
    artifact: z.string(),
    path: z.string().exactOptional(),
    review: z.string().exactOptional(),
    after: z.string().exactOptional(),
    all: z.boolean().exactOptional(),
  }),
  z.strictObject({
    operation: z.literal("comment"),
    artifact: z.string(),
    body: z.string().exactOptional(),
    path: z.string().exactOptional(),
    replyTo: z.string().exactOptional(),
    idempotencyKey: z.string(),
    version: nonNegativeSafeInt.exactOptional(),
    anchor: anchorFieldSchema.exactOptional(),
    images: sha256ListSchema.exactOptional(),
  }),
  z.strictObject({
    operation: z.literal("review"),
    artifact: z.string(),
    body: z.string().exactOptional(),
    idempotencyKey: z.string(),
    version: nonNegativeSafeInt.exactOptional(),
    comments: z.array(reviewCommentFieldSchema),
  }),
  z.strictObject({
    operation: z.literal("resolve"),
    artifact: z.string(),
    comment: z.string(),
    note: z.string().exactOptional(),
  }),
  z.strictObject({
    operation: z.literal("reopen"),
    artifact: z.string(),
    comment: z.string(),
  }),
  z.strictObject({
    operation: z.literal("save"),
    attachment: z.string(),
  }),
  z.strictObject({
    operation: z.literal("image"),
    artifact: z.string(),
    image: z.string(),
  }),
  z.strictObject({
    operation: z.literal("follow"),
    artifact: z.string(),
  }),
  z.strictObject({
    operation: z.literal("unfollow"),
    artifact: z.string(),
  }),
]);

type OperationTraits = {
  repeatable?: true;
  gatedByComments?: true;
  commentWrite?: true;
};

const OPERATION_TRAITS: Record<AgentArtifactRequest["operation"], OperationTraits> = {
  list: { repeatable: true },
  read: { repeatable: true },
  check: { repeatable: true },
  "check-shot": { repeatable: true },
  push: { gatedByComments: true },
  move: {},
  delete: {},
  comments: { repeatable: true },
  comment: { gatedByComments: true, commentWrite: true },
  review: { gatedByComments: true, commentWrite: true },
  resolve: { gatedByComments: true, commentWrite: true },
  reopen: { commentWrite: true },
  save: {},
  image: { repeatable: true },
  follow: { repeatable: true },
  unfollow: { repeatable: true },
};

export function artifactOperationTraits(operation: AgentArtifactRequest["operation"]) {
  const shape = OPERATION_TRAITS[operation];
  return {
    repeatable: shape.repeatable === true,
    gatedByComments: shape.gatedByComments === true,
    commentWrite: shape.commentWrite === true,
  };
}

export function decodeAgentArtifactRequest(value: unknown): AgentArtifactRequest | null {
  const parsed = agentArtifactRequestSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

const FORBIDDEN_PATH_CHARS = /[\\:%?#\p{Cc}\p{Cf}]/u;
const GIT_SHORT_NAME = /^git~\d+$/i;

function isGitDirectorySegment(segment: string): boolean {
  const normalized = segment.replace(/[. ]+$/, "").toLowerCase();
  return normalized === ".git" || GIT_SHORT_NAME.test(normalized);
}

export function artifactPathValid(path: string): boolean {
  if (!path || path.startsWith("/") || path.endsWith("/")) return false;
  return path
    .split("/")
    .every(
      (segment) =>
        segment.length > 0 &&
        segment !== "." &&
        segment !== ".." &&
        !FORBIDDEN_PATH_CHARS.test(segment) &&
        !isGitDirectorySegment(segment),
    );
}
