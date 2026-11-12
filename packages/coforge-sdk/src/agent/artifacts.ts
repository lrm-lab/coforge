/**
 * `coforge artifact create|list|read|push|history|revert` (task #385): an Agent's documents, one
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
    };

const OPERATION_FIELDS = {
  create: {
    strings: ["title", "target", "kind", "description", "text", "idempotencyKey", "entry"],
    numbers: [],
    arrays: ["delete"],
    manifest: true,
    required: ["title"],
  },
  list: { strings: ["target", "query", "after"], numbers: ["limit"], required: [] },
  read: { strings: ["artifact"], numbers: ["version"], required: ["artifact"] },
  push: {
    strings: [
      "artifact",
      "idempotencyKey",
      "text",
      "title",
      "description",
      "note",
      "label",
      "entry",
    ],
    numbers: ["baseVersion"],
    arrays: ["delete"],
    manifest: true,
    required: ["artifact", "idempotencyKey", "baseVersion"],
  },
  history: { strings: ["artifact"], numbers: ["before", "limit"], required: ["artifact"] },
  revert: {
    strings: ["artifact", "idempotencyKey"],
    numbers: ["to", "baseVersion"],
    required: ["artifact", "idempotencyKey", "to", "baseVersion"],
  },
  share: {
    strings: ["note", "requestId"],
    numbers: [],
    arrays: ["artifactIds", "targets"],
    required: ["artifactIds", "targets", "requestId"],
  },
} as const satisfies Record<
  AgentArtifactRequest["operation"],
  {
    strings: readonly string[];
    numbers: readonly string[];
    arrays?: readonly string[];
    /** Takes `files`, a manifest of `{ path, sha256 }`. */
    manifest?: boolean;
    required: readonly string[];
  }
>;

/**
 * The request a body is, or null: a known operation with exactly its own fields, strings as
 * strings and numbers as whole non-negative numbers. Nothing else is passed on, so a client
 * cannot reach a save's internal options.
 */
export function decodeAgentArtifactRequest(value: unknown): AgentArtifactRequest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const fields = value as Record<string, unknown>;
  const operation = fields.operation;
  if (typeof operation !== "string" || !Object.hasOwn(OPERATION_FIELDS, operation)) return null;
  const known = OPERATION_FIELDS[operation as keyof typeof OPERATION_FIELDS];
  const request: Record<string, unknown> = { operation };
  for (const [key, field] of Object.entries(fields)) {
    if (key === "operation") continue;
    if ((known.strings as readonly string[]).includes(key)) {
      if (typeof field !== "string") return null;
    } else if ((known.numbers as readonly string[]).includes(key)) {
      if (!Number.isSafeInteger(field) || (field as number) < 0) return null;
    } else if ((known as { arrays?: readonly string[] }).arrays?.includes(key)) {
      if (!Array.isArray(field) || !field.every((item) => typeof item === "string")) return null;
    } else if (key === "files" && (known as { manifest?: boolean }).manifest) {
      if (!Array.isArray(field) || !field.every(isManifestFile)) return null;
    } else return null;
    request[key] = field;
  }
  if (known.required.some((key) => request[key] === undefined)) return null;
  const manifest = ["files", "delete", "entry"].some((key) => request[key] !== undefined);
  if (manifest && request.text !== undefined) return null;
  return request as AgentArtifactRequest;
}

const SHA256 = /^[0-9a-f]{64}$/;

function isManifestFile(value: unknown): value is AgentArtifactFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  const file = value as Record<string, unknown>;
  return (
    keys.length === 2 &&
    typeof file.path === "string" &&
    typeof file.sha256 === "string" &&
    SHA256.test(file.sha256)
  );
}
