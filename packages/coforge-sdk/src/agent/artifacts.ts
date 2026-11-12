import { isRecord } from "#src/internal/json-record";
import {
  isAnchorShape,
  isReviewCommentShape,
  type AgentArtifactAnchor,
  type AgentReviewComment,
} from "./artifact-comments";

/**
 * `coforge artifact create|list|read|push|history|revert|comments|comment|review|resolve|reopen`
 * (task #385): an Agent's documents, one
 * operation per request on `POST /api/agent/v1/artifacts`. A document is sent and read as its
 * text, as the web page does; the server checks the `artifacts` experiment and the document's
 * home (a conversation, or the Workspace) for every operation.
 */

/** The largest artifact request the local proxy admits: a 2 MiB document, JSON-escaped. */
export const ARTIFACT_REQUEST_MAX_BYTES = 8 * 1024 * 1024;

/** The largest file an Agent uploads for a push: a text file's limit (a binary one's is 15 MiB). */
export const ARTIFACT_UPLOAD_MAX_BYTES = 16 * 1024 * 1024;

/** One file a create or push adds or replaces: its path in the artifact and the sha256 of bytes
 * already uploaded. A push answered `missing` names the sha256s to upload before sending it
 * again. */
export type AgentArtifactFile = { path: string; sha256: string };

/** A version's files go either as one `text` (the entry file's) or as a manifest: `files` added or
 * replaced, `delete` removed, `entry` the file it opens at. Never both. */
type ArtifactManifest = { files?: AgentArtifactFile[]; delete?: string[]; entry?: string };

/** One artifact operation. `target` is `#channel` or `dm:@person`; none is the Workspace. */
export type AgentArtifactRequest =
  | ({
      operation: "create";
      title: string;
      target?: string;
      /** `html` makes a web page (task #490); a document (`markdown`) by default. */
      kind?: "markdown" | "html";
      /** One line saying what it is, shown on its card; a web page needs one. */
      description?: string;
      text?: string;
      idempotencyKey?: string;
    } & ArtifactManifest)
  | { operation: "list"; target?: string; query?: string; after?: string; limit?: number }
  | { operation: "read"; artifact: string; version?: number }
  | ({
      operation: "push";
      artifact: string;
      baseVersion: number;
      idempotencyKey: string;
      text?: string;
      title?: string;
      description?: string;
      note?: string;
      label?: string;
    } & ArtifactManifest)
  | { operation: "history"; artifact: string; before?: number; limit?: number }
  | {
      operation: "revert";
      artifact: string;
      to: number;
      baseVersion: number;
      idempotencyKey: string;
    }
  | {
      operation: "share";
      artifactIds: string[];
      targets: string[];
      note?: string;
      requestId: string;
    }
  | {
      operation: "comments";
      artifact: string;
      path?: string;
      /** Everything, without moving the Agent's place; the default is what others wrote since. */
      all?: boolean;
      review?: string;
      after?: string;
    }
  | {
      operation: "comment";
      artifact: string;
      body: string;
      path?: string;
      anchor?: AgentArtifactAnchor;
      replyTo?: string;
      version?: number;
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
  | { operation: "resolve"; artifact: string; comment: string; note?: string }
  | { operation: "reopen"; artifact: string; comment: string };

/** What a field of a request is on the wire: a string, a whole non-negative number, a boolean, a
 * list of strings, a manifest of files (`{ path, sha256 }`), an anchor (`{ type, data }`) or a
 * review's comments. */
type FieldKind =
  | "string"
  | "number"
  | "boolean"
  | "strings"
  | "files"
  | "anchor"
  | "reviewComments";

const FIELD_CHECKS: Record<FieldKind, (value: unknown) => boolean> = {
  string: (value) => typeof value === "string",
  number: (value) => Number.isSafeInteger(value) && (value as number) >= 0,
  boolean: (value) => typeof value === "boolean",
  strings: (value) => Array.isArray(value) && value.every((item) => typeof item === "string"),
  files: (value) => Array.isArray(value) && value.every(isManifestFile),
  anchor: isAnchorShape,
  reviewComments: (value) => Array.isArray(value) && value.every(isReviewCommentShape),
};

/** The fields a version sent as files carries, which `text` never comes with. */
const MANIFEST_FIELDS = { files: "files", delete: "strings", entry: "string" } as const;

type OperationShape = {
  fields: Record<string, FieldKind>;
  required: readonly string[];
  /** Changes nothing: a failure on the way is safe to run again. */
  readOnly?: true;
  /** Held up while others commented on what it touches since the Agent last read comments. */
  gatedByComments?: true;
  /** Writes a comment or the state of a thread. */
  commentWrite?: true;
};

const OPERATIONS = {
  create: {
    fields: {
      title: "string",
      target: "string",
      kind: "string",
      description: "string",
      text: "string",
      idempotencyKey: "string",
      ...MANIFEST_FIELDS,
    },
    required: ["title"],
  },
  list: {
    fields: { target: "string", query: "string", after: "string", limit: "number" },
    required: [],
    readOnly: true,
  },
  read: {
    fields: { artifact: "string", version: "number" },
    required: ["artifact"],
    readOnly: true,
  },
  push: {
    fields: {
      artifact: "string",
      idempotencyKey: "string",
      text: "string",
      title: "string",
      description: "string",
      note: "string",
      label: "string",
      baseVersion: "number",
      ...MANIFEST_FIELDS,
    },
    required: ["artifact", "idempotencyKey", "baseVersion"],
    gatedByComments: true,
  },
  history: {
    fields: { artifact: "string", before: "number", limit: "number" },
    required: ["artifact"],
    readOnly: true,
  },
  revert: {
    fields: { artifact: "string", idempotencyKey: "string", to: "number", baseVersion: "number" },
    required: ["artifact", "idempotencyKey", "to", "baseVersion"],
  },
  share: {
    fields: { note: "string", requestId: "string", artifactIds: "strings", targets: "strings" },
    required: ["artifactIds", "targets", "requestId"],
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
    readOnly: true,
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
    },
    required: ["artifact", "body", "idempotencyKey"],
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
    commentWrite: true,
  },
  reopen: {
    fields: { artifact: "string", comment: "string" },
    required: ["artifact", "comment"],
    commentWrite: true,
  },
} as const satisfies Record<AgentArtifactRequest["operation"], OperationShape>;

/** What an operation does, for a client that reports its failures: whether it only reads, whether
 * unseen comments hold it up, and whether it writes a comment or the state of a thread. */
export function artifactOperationTraits(operation: AgentArtifactRequest["operation"]) {
  const shape: OperationShape = OPERATIONS[operation];
  return {
    readOnly: shape.readOnly === true,
    gatedByComments: shape.gatedByComments === true,
    commentWrite: shape.commentWrite === true,
  };
}

/**
 * The request a body is, or null: a known operation with exactly its own fields, strings as
 * strings and numbers as whole non-negative numbers. Nothing else is passed on, so a client
 * cannot reach a save's internal options.
 */
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
  const manifest = Object.keys(MANIFEST_FIELDS).some((key) => request[key] !== undefined);
  if (manifest && request.text !== undefined) return null;
  return request as AgentArtifactRequest;
}

/** A file's bytes are named by their sha256, as 64 lowercase hex digits, on every artifact route. */
export const ARTIFACT_SHA256_PATTERN = /^[0-9a-f]{64}$/;

/**
 * A file path inside an artifact, as segments: no empty segment (`a//b`, a trailing `/`), no
 * `.`/`..`, no backslash, colon or control character, nothing absolute. `a..b.txt` is a normal
 * name and passes. The server refuses any other path; a client checks the same rule.
 */
export function artifactPathValid(path: string): boolean {
  if (!path || path.startsWith("/") || path.endsWith("/")) return false;
  return path
    .split("/")
    .every(
      (segment) =>
        segment.length > 0 &&
        segment !== "." &&
        segment !== ".." &&
        !/[\\:\u0000-\u001f\u007f]/.test(segment),
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
