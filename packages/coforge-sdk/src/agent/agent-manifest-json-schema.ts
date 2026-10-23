import { APP_SCOPES } from "#src/internal/app-scopes";
import {
  AGENT_MANIFEST_EFFECTS,
  AGENT_MANIFEST_KEYS as KEYS,
  AGENT_MANIFEST_LIMITS as LIMITS,
  AGENT_MANIFEST_IDEMPOTENCY,
  AGENT_MANIFEST_METHODS,
  AGENT_MANIFEST_SCHEMA_ID,
  AGENT_MANIFEST_SCHEMA_KEYWORDS,
  AGENT_MANIFEST_SCHEMA_TYPES,
} from "./agent-manifest-types";

/** The `properties` of an object: exactly the fields the parser allows, in the parser's order. */
const only = <K extends string>(keys: readonly K[], all: Record<K, unknown>) =>
  Object.fromEntries(keys.map((key) => [key, all[key]]));

const text = (maxLength: number) => ({ type: "string", minLength: 1, maxLength });
const url = { type: "string", format: "uri", pattern: "^https://", maxLength: LIMITS.urlMaxLength };

/** The `x-` extension keys every object allows. */
const extensions = { patternProperties: { "^x-": {} } };

const schemaNode = {
  type: "object",
  description: `A bounded JSON Schema subset. Also at most ${LIMITS.schemaMaxDepth} levels deep, ${LIMITS.schemaMaxNodes} nodes, ${LIMITS.schemaMaxProperties} properties per object, ${LIMITS.schemaMaxEnum} enum values.`,
  additionalProperties: false,
  properties: only(AGENT_MANIFEST_SCHEMA_KEYWORDS, {
    type: { enum: [...AGENT_MANIFEST_SCHEMA_TYPES] },
    properties: {
      type: "object",
      additionalProperties: { $ref: "#/$defs/schemaNode" },
    },
    required: { type: "array", items: { type: "string" }, uniqueItems: true },
    items: { $ref: "#/$defs/schemaNode" },
    enum: { type: "array", minItems: 1, maxItems: LIMITS.schemaMaxEnum },
    description: text(LIMITS.descriptionMaxLength),
    title: text(LIMITS.schemaTitleMaxLength),
    minimum: { type: "number" },
    maximum: { type: "number" },
    minLength: { type: "integer", minimum: 0 },
    maxLength: { type: "integer", minimum: 0 },
    minItems: { type: "integer", minimum: 0 },
    maxItems: { type: "integer", minimum: 0 },
    pattern: text(LIMITS.schemaPatternMaxLength),
    format: text(LIMITS.schemaFormatMaxLength),
    additionalProperties: { type: "boolean" },
    const: {},
    default: {},
  }),
  ...extensions,
};

const action = {
  type: "object",
  required: ["name", "effect", "endpoint", "idempotency", "required_scopes", "input_schema"],
  additionalProperties: false,
  properties: only(KEYS.action, {
    name: { type: "string", pattern: LIMITS.actionNamePattern.source },
    description: text(LIMITS.descriptionMaxLength),
    effect: { enum: [...AGENT_MANIFEST_EFFECTS] },
    endpoint: {
      type: "object",
      required: ["method", "path"],
      additionalProperties: false,
      properties: only(KEYS.endpoint, {
        method: { enum: [...AGENT_MANIFEST_METHODS] },
        path: {
          type: "string",
          pattern: `^/(?!/)${LIMITS.pathCharacters}*$`,
          maxLength: LIMITS.pathMaxLength,
        },
      }),
      ...extensions,
    },
    idempotency: { enum: [...AGENT_MANIFEST_IDEMPOTENCY] },
    idempotency_header: { type: "string", pattern: LIMITS.idempotencyHeaderPattern.source },
    required_scopes: {
      type: "array",
      maxItems: LIMITS.maxScopes,
      uniqueItems: true,
      items: { enum: [...APP_SCOPES] },
    },
    input_schema: { $ref: "#/$defs/schemaNode" },
    output_schema: { $ref: "#/$defs/schemaNode" },
  }),
  anyOf: [
    {
      required: ["idempotency_header"],
      properties: { idempotency: { const: "key_required" } },
    },
    {
      not: { required: ["idempotency_header"] },
      properties: { idempotency: { enum: ["safe", "idempotent", "non_idempotent"] } },
    },
  ],
  ...extensions,
};

/**
 * JSON Schema (draft 2020-12) for `coforge-agent-manifest.v1`, published as
 * `docs/agent-manifest/coforge-agent-manifest.v1.schema.json` so a template can name it. It states
 * the structure and bounds; `parseAgentManifest` also enforces what a schema cannot: the
 * effect/method/idempotency coherence, sorted scopes, unique action names, path parameters being
 * required inputs and the schema subset's depth and node limits.
 */
export const AGENT_MANIFEST_JSON_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: AGENT_MANIFEST_SCHEMA_ID,
  type: "object",
  required: ["schema", "execution"],
  additionalProperties: false,
  properties: only(KEYS.top, {
    schema: { const: AGENT_MANIFEST_SCHEMA_ID },
    name: text(LIMITS.nameMaxLength),
    description: text(LIMITS.descriptionMaxLength),
    docs_url: url,
    app_origin: url,
    execution: {
      oneOf: [
        {
          type: "object",
          required: ["mode", "base_url"],
          additionalProperties: false,
          properties: only(KEYS.executionHttpApi, { mode: { const: "http_api" }, base_url: url }),
          ...extensions,
        },
        {
          type: "object",
          required: ["mode", "command"],
          additionalProperties: false,
          properties: only(KEYS.executionLocalCli, {
            mode: { const: "local_cli" },
            command: {
              type: "string",
              pattern: LIMITS.commandPattern.source,
              maxLength: LIMITS.commandMaxLength,
            },
          }),
          ...extensions,
        },
      ],
    },
    credential_boundary: {
      type: "object",
      required: ["storage", "forbid_user_home"],
      additionalProperties: false,
      properties: only(KEYS.credentialBoundary, {
        storage: { const: "per_agent_home" },
        forbid_user_home: { const: true },
      }),
      ...extensions,
    },
    auth: {
      type: "object",
      required: ["type"],
      additionalProperties: false,
      properties: only(KEYS.auth, { type: { const: "login_with_coforge" } }),
      ...extensions,
    },
    actions: { type: "array", maxItems: LIMITS.maxActions, items: { $ref: "#/$defs/action" } },
  }),
  ...extensions,
  $defs: { action, schemaNode },
};
