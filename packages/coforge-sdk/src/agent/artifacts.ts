/**
 * `coforge artifact create|read|push|history|revert` (task #385): an Agent's documents, one
 * operation per request on `POST /api/agent/v1/artifacts`. A document is sent and read as its
 * text, as the web page does; the server checks the `artifacts` experiment and the document's
 * home (a conversation, or the Workspace) for every operation.
 */

/** The largest artifact request the local proxy admits: a 2 MiB document, JSON-escaped. */
export const ARTIFACT_REQUEST_MAX_BYTES = 8 * 1024 * 1024;

/** One artifact operation. `target` is `#channel` or `dm:@person`; none is the Workspace. */
export type AgentArtifactRequest =
  | { operation: "create"; title: string; target?: string; text?: string }
  | { operation: "read"; artifact: string; version?: number }
  | {
      operation: "push";
      artifact: string;
      baseVersion: number;
      idempotencyKey: string;
      text?: string;
      title?: string;
      description?: string;
      note?: string;
      label?: string;
    }
  | { operation: "history"; artifact: string; before?: number; limit?: number }
  | {
      operation: "revert";
      artifact: string;
      to: number;
      baseVersion: number;
      idempotencyKey: string;
    };

const OPERATION_FIELDS = {
  create: { strings: ["title", "target", "text"], numbers: [], required: ["title"] },
  read: { strings: ["artifact"], numbers: ["version"], required: ["artifact"] },
  push: {
    strings: ["artifact", "idempotencyKey", "text", "title", "description", "note", "label"],
    numbers: ["baseVersion"],
    required: ["artifact", "idempotencyKey", "baseVersion"],
  },
  history: { strings: ["artifact"], numbers: ["before", "limit"], required: ["artifact"] },
  revert: {
    strings: ["artifact", "idempotencyKey"],
    numbers: ["to", "baseVersion"],
    required: ["artifact", "idempotencyKey", "to", "baseVersion"],
  },
} as const satisfies Record<
  AgentArtifactRequest["operation"],
  { strings: readonly string[]; numbers: readonly string[]; required: readonly string[] }
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
    } else return null;
    request[key] = field;
  }
  if (known.required.some((key) => request[key] === undefined)) return null;
  return request as AgentArtifactRequest;
}
