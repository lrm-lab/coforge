/**
 * Types and bounds of the public Agent manifest `coforge-agent-manifest.v1`: the JSON document an
 * app publishes so an Agent can learn what the app can do. The spec lives in
 * `docs/agent-manifest/README.md`; `parseAgentManifest` is its one validator.
 */

export const AGENT_MANIFEST_SCHEMA_ID = "coforge-agent-manifest.v1";

export const AGENT_MANIFEST_EXECUTION_MODES = ["http_api", "local_cli"] as const;
export const AGENT_MANIFEST_EFFECTS = [
  "read",
  "create",
  "update",
  "delete",
  "external_side_effect",
] as const;
export const AGENT_MANIFEST_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export const AGENT_MANIFEST_IDEMPOTENCY = [
  "safe",
  "idempotent",
  "key_required",
  "non_idempotent",
] as const;

export type AgentManifestEffect = (typeof AGENT_MANIFEST_EFFECTS)[number];
export type AgentManifestMethod = (typeof AGENT_MANIFEST_METHODS)[number];
export type AgentManifestIdempotency = (typeof AGENT_MANIFEST_IDEMPOTENCY)[number];

/** Bounds, in code units for strings and counts otherwise. A document past any of them is invalid. */
export const AGENT_MANIFEST_LIMITS = {
  nameMaxLength: 80,
  descriptionMaxLength: 500,
  urlMaxLength: 2048,
  /** The manifest document, in bytes. */
  maxBytes: 1024 * 1024,
  commandMaxLength: 64,
  /** A bare command name: no path separators, whitespace or shell characters, no leading ".". */
  commandPattern: /^[A-Za-z0-9_+-][A-Za-z0-9._+-]*$/,
  maxActions: 64,
  actionNamePattern: /^[A-Za-z0-9._:-]{1,80}$/,
  pathMaxLength: 512,
  idempotencyHeaderPattern: /^[A-Za-z0-9-]{1,64}$/,
  maxScopes: 64,
  scopePattern: /^[A-Za-z0-9._:/-]{1,128}$/,
  /** Input and output schemas: a bounded subset of JSON Schema. */
  schemaMaxDepth: 12,
  schemaMaxNodes: 256,
  schemaMaxProperties: 128,
  schemaMaxEnum: 64,
  schemaPropertyNameMaxLength: 80,
  /** Characters of an endpoint path, `{param}` placeholders included; never whitespace. */
  pathCharacters: "[A-Za-z0-9._~!$&'()*+,;=:%/{}-]",
  schemaPatternMaxLength: 256,
  schemaTitleMaxLength: 120,
  schemaFormatMaxLength: 32,
  /** Problems reported at most, so a hostile document cannot produce an unbounded list. */
  maxProblems: 50,
} as const;

/** The one grammar of a `{param}` name in an endpoint path (source text, for building patterns). */
export const AGENT_MANIFEST_PATH_PARAM_NAME = "[A-Za-z_][A-Za-z0-9_]*";
/** Matches each `{param}` of an endpoint path; group 1 is the name. Global: use with `matchAll`
 * or `replace`, not `test`/`exec`. */
export const AGENT_MANIFEST_PATH_PARAM = new RegExp(
  `\\{(${AGENT_MANIFEST_PATH_PARAM_NAME})\\}`,
  "g",
);

/** The fields each object of the document may carry (besides `x-` keys), parser and schema alike. */
export const AGENT_MANIFEST_KEYS = {
  top: [
    "schema",
    "name",
    "description",
    "docs_url",
    "app_origin",
    "execution",
    "credential_boundary",
    "auth",
    "actions",
  ],
  executionHttpApi: ["mode", "base_url"],
  executionLocalCli: ["mode", "command"],
  credentialBoundary: ["storage", "forbid_user_home"],
  auth: ["type"],
  action: [
    "name",
    "description",
    "effect",
    "endpoint",
    "idempotency",
    "idempotency_header",
    "required_scopes",
    "input_schema",
    "output_schema",
  ],
  endpoint: ["method", "path"],
} as const;

/** The JSON Schema keywords an action's input and output schema may use (plus `x-` keys). */
export const AGENT_MANIFEST_SCHEMA_KEYWORDS = [
  "type",
  "properties",
  "required",
  "items",
  "enum",
  "const",
  "description",
  "title",
  "minimum",
  "maximum",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "pattern",
  "format",
  "additionalProperties",
  "default",
] as const;

export const AGENT_MANIFEST_SCHEMA_TYPES = [
  "string",
  "integer",
  "number",
  "boolean",
  "object",
  "array",
  "null",
] as const;

/** One schema node, already checked against the subset. */
export type AgentManifestSchemaNode = { [keyword: string]: unknown };

export type AgentManifestAction = {
  name: string;
  description?: string;
  effect: AgentManifestEffect;
  endpoint: { method: AgentManifestMethod; path: string };
  idempotency: AgentManifestIdempotency;
  idempotency_header?: string;
  required_scopes: string[];
  input_schema: AgentManifestSchemaNode;
  output_schema?: AgentManifestSchemaNode;
};

export type AgentManifestExecution =
  | { mode: "http_api"; base_url: string }
  | { mode: "local_cli"; command: string };

/** A parsed manifest keeps the document's own (snake_case) field names; `x-` keys are dropped. */
export type AgentManifest = {
  schema: typeof AGENT_MANIFEST_SCHEMA_ID;
  name?: string;
  description?: string;
  docs_url?: string;
  app_origin?: string;
  execution: AgentManifestExecution;
  credential_boundary?: { storage: "per_agent_home"; forbid_user_home: true };
  auth?: { type: "login_with_coforge" };
  actions: AgentManifestAction[];
};

/** `path` is a JSON Pointer into the document (`""` is the document itself). */
export type AgentManifestProblem = { path: string; message: string };

export type AgentManifestParseResult =
  | { ok: true; manifest: AgentManifest }
  | { ok: false; problems: AgentManifestProblem[] };
