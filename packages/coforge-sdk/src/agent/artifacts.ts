import { isRecord } from "#src/internal/json-record";
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

type FieldKind =
  | "string"
  | "sha256s"
  | "number"
  | "boolean"
  | "strings"
  | "files"
  | "anchor"
  | "reviewComments"
  | "checkShot";

const FIELD_CHECKS: Record<FieldKind, (value: unknown) => boolean> = {
  string: (value) => typeof value === "string",
  sha256s: (value) =>
    Array.isArray(value) &&
    value.length <= ARTIFACT_COMMENT_IMAGES_MAX &&
    value.every((item) => typeof item === "string" && ARTIFACT_SHA256_PATTERN.test(item)),
  number: (value) => Number.isSafeInteger(value) && (value as number) >= 0,
  boolean: (value) => typeof value === "boolean",
  strings: (value) => Array.isArray(value) && value.every((item) => typeof item === "string"),
  files: (value) => Array.isArray(value) && value.every(isManifestFile),
  anchor: isAnchorShape,
  reviewComments: (value) => Array.isArray(value) && value.every(isReviewCommentShape),
  checkShot: isArtifactCheckShot,
};

type OperationShape = {
  fields: Record<string, FieldKind>;
  required: readonly string[];
  repeatable?: true;
  gatedByComments?: true;
  commentWrite?: true;
};

const OPERATIONS = {
  list: {
    fields: { target: "string", query: "string", after: "string", limit: "number" },
    required: [],
    repeatable: true,
  },
  read: {
    fields: { artifact: "string", version: "number" },
    required: ["artifact"],
    repeatable: true,
  },
  check: {
    fields: { artifact: "string", version: "number" },
    required: ["artifact"],
    repeatable: true,
  },
  "check-shot": {
    fields: { artifact: "string", version: "number", shot: "checkShot" },
    required: ["artifact", "shot"],
    repeatable: true,
  },
  push: {
    fields: {
      artifact: "string",
      target: "string",
      idempotencyKey: "string",
      title: "string",
      description: "string",
      note: "string",
      label: "string",
      baseVersion: "number",
      files: "files",
      delete: "strings",
      entry: "string",
    },
    required: ["idempotencyKey"],
    gatedByComments: true,
  },
  move: {
    fields: { artifact: "string", to: "string" },
    required: ["artifact", "to"],
  },
  delete: {
    fields: { artifact: "string" },
    required: ["artifact"],
  },
  comments: {
    fields: {
      artifact: "string",
      path: "string",
      review: "string",
      after: "string",
      all: "boolean",
    },
    required: ["artifact"],
    repeatable: true,
  },
  comment: {
    fields: {
      artifact: "string",
      body: "string",
      path: "string",
      replyTo: "string",
      idempotencyKey: "string",
      version: "number",
      anchor: "anchor",
      images: "sha256s",
    },
    required: ["artifact", "idempotencyKey"],
    gatedByComments: true,
    commentWrite: true,
  },
  review: {
    fields: {
      artifact: "string",
      body: "string",
      idempotencyKey: "string",
      version: "number",
      comments: "reviewComments",
    },
    required: ["artifact", "comments", "idempotencyKey"],
    gatedByComments: true,
    commentWrite: true,
  },
  resolve: {
    fields: { artifact: "string", comment: "string", note: "string" },
    required: ["artifact", "comment"],
    gatedByComments: true,
    commentWrite: true,
  },
  reopen: {
    fields: { artifact: "string", comment: "string" },
    required: ["artifact", "comment"],
    commentWrite: true,
  },
  save: { fields: { attachment: "string" }, required: ["attachment"] },
  image: {
    fields: { artifact: "string", image: "string" },
    required: ["artifact", "image"],
    repeatable: true,
  },
  follow: { fields: { artifact: "string" }, required: ["artifact"], repeatable: true },
  unfollow: { fields: { artifact: "string" }, required: ["artifact"], repeatable: true },
} as const satisfies Record<AgentArtifactRequest["operation"], OperationShape>;

export function artifactOperationTraits(operation: AgentArtifactRequest["operation"]) {
  const shape: OperationShape = OPERATIONS[operation];
  return {
    repeatable: shape.repeatable === true,
    gatedByComments: shape.gatedByComments === true,
    commentWrite: shape.commentWrite === true,
  };
}

const PUSH_OVER_ONLY = ["baseVersion", "note", "label", "delete"] as const;

export function decodeAgentArtifactRequest(value: unknown): AgentArtifactRequest | null {
  if (!isRecord(value)) return null;
  const operation = value.operation;
  if (typeof operation !== "string" || !Object.hasOwn(OPERATIONS, operation)) return null;
  const known: OperationShape = OPERATIONS[operation as keyof typeof OPERATIONS];
  const request: Record<string, unknown> = { operation };
  for (const [key, field] of Object.entries(value)) {
    if (key === "operation") continue;
    if (!Object.hasOwn(known.fields, key) || !FIELD_CHECKS[known.fields[key]!](field)) return null;
    request[key] = field;
  }
  if (known.required.some((key) => request[key] === undefined)) return null;
  if (operation === "push") {
    if (request.artifact !== undefined) {
      if (request.baseVersion === undefined || request.target !== undefined) return null;
    } else if (
      request.title === undefined ||
      request.files === undefined ||
      PUSH_OVER_ONLY.some((key) => request[key] !== undefined)
    )
      return null;
  }
  return request as AgentArtifactRequest;
}

export const ARTIFACT_SHA256_PATTERN = /^[0-9a-f]{64}$/;

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

function isManifestFile(value: unknown): value is AgentArtifactFile {
  if (!isRecord(value)) return false;
  return (
    Object.keys(value).length === 2 &&
    typeof value.path === "string" &&
    typeof value.sha256 === "string" &&
    ARTIFACT_SHA256_PATTERN.test(value.sha256)
  );
}
