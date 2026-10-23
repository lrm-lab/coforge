import { isRecord } from "#src/internal/json-record";
import {
  checkEndpointPath,
  deniedIdempotencyHeader,
  httpsUrlProblem,
} from "./agent-manifest-checks";
import {
  checkSchemaSubset,
  pointer,
  rejectUnknownKeys,
  type ReportProblem,
} from "./agent-manifest-schema-subset";
import {
  AGENT_MANIFEST_EFFECTS,
  AGENT_MANIFEST_EXECUTION_MODES,
  AGENT_MANIFEST_IDEMPOTENCY,
  AGENT_MANIFEST_LIMITS as LIMITS,
  AGENT_MANIFEST_KEYS as KEYS,
  AGENT_MANIFEST_METHODS,
  AGENT_MANIFEST_PATH_PARAM,
  AGENT_MANIFEST_SCHEMA_ID,
  type AgentManifest,
  type AgentManifestAction,
  type AgentManifestEffect,
  type AgentManifestIdempotency,
  type AgentManifestMethod,
  type AgentManifestParseResult,
  type AgentManifestProblem,
} from "./agent-manifest-types";

export * from "./agent-manifest-types";

const isText = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length >= 1 && value.length <= max;

/** The coherence rules: what an action does, how it is called and whether repeating it is safe
 * agree. Each is [violated?, field it is reported on, message]; unset facts never violate. */
type Facts = {
  effect?: AgentManifestEffect;
  method?: AgentManifestMethod;
  idempotency?: AgentManifestIdempotency;
};
const COHERENCE: readonly (readonly [
  (facts: Facts) => boolean,
  "effect" | "idempotency",
  string,
])[] = [
  [
    (f) => f.method === "GET" && !!f.effect && f.effect !== "read",
    "effect",
    'a GET action must have effect "read"',
  ],
  [
    (f) => f.effect === "read" && !!f.method && f.method !== "GET",
    "effect",
    'effect "read" requires method GET',
  ],
  [
    (f) => f.effect === "read" && !!f.idempotency && f.idempotency !== "safe",
    "idempotency",
    'effect "read" requires idempotency "safe"',
  ],
  [
    (f) => f.effect === "delete" && !!f.method && f.method !== "DELETE",
    "effect",
    'effect "delete" requires method DELETE',
  ],
  [
    (f) => !!f.effect && f.effect !== "read" && f.idempotency === "safe",
    "idempotency",
    'only effect "read" may be idempotency "safe"',
  ],
];

function optionalText(
  object: Record<string, unknown>,
  key: string,
  path: string,
  max: number,
  report: ReportProblem,
) {
  if (object[key] === undefined) return undefined;
  const value = object[key];
  if (isText(value, max)) return value;
  report(pointer(path, key), `must be a string of 1 to ${max} characters`);
  return undefined;
}

function parseAction(
  value: unknown,
  path: string,
  report: ReportProblem,
): AgentManifestAction | undefined {
  if (!isRecord(value)) return (report(path, "must be an object"), undefined);
  rejectUnknownKeys(value, KEYS.action, path, report);
  const at = (key: string) => pointer(path, key);
  const atEndpoint = (key: string) => pointer(at("endpoint"), key);
  const name =
    typeof value.name === "string" && LIMITS.actionNamePattern.test(value.name)
      ? value.name
      : undefined;
  if (name === undefined) report(at("name"), `must match ${LIMITS.actionNamePattern.source}`);
  const description = optionalText(value, "description", path, LIMITS.descriptionMaxLength, report);

  const effect = AGENT_MANIFEST_EFFECTS.find((item) => item === value.effect);
  if (!effect) report(at("effect"), `must be one of ${AGENT_MANIFEST_EFFECTS.join(", ")}`);
  const idempotency = AGENT_MANIFEST_IDEMPOTENCY.find((item) => item === value.idempotency);
  if (!idempotency)
    report(at("idempotency"), `must be one of ${AGENT_MANIFEST_IDEMPOTENCY.join(", ")}`);

  let method: AgentManifestAction["endpoint"]["method"] | undefined;
  let endpointPath: string | undefined;
  const endpoint = value.endpoint;
  if (!isRecord(endpoint)) report(at("endpoint"), "must be an object");
  else {
    rejectUnknownKeys(endpoint, KEYS.endpoint, at("endpoint"), report);
    method = AGENT_MANIFEST_METHODS.find((item) => item === endpoint.method);
    if (!method)
      report(atEndpoint("method"), `must be one of ${AGENT_MANIFEST_METHODS.join(", ")}`);
    const problem = checkEndpointPath(endpoint.path);
    if (problem) report(atEndpoint("path"), problem);
    else endpointPath = endpoint.path as string;
  }

  let header: string | undefined;
  if (value.idempotency_header !== undefined) {
    if (idempotency !== "key_required")
      report(at("idempotency_header"), 'is allowed only with idempotency "key_required"');
    else if (
      typeof value.idempotency_header !== "string" ||
      !LIMITS.idempotencyHeaderPattern.test(value.idempotency_header)
    )
      report(at("idempotency_header"), "must be an HTTP header name");
    else {
      const denied = deniedIdempotencyHeader(value.idempotency_header);
      if (denied) report(at("idempotency_header"), denied);
      else header = value.idempotency_header;
    }
  } else if (idempotency === "key_required")
    report(at("idempotency_header"), 'is required with idempotency "key_required"');

  const facts: Facts = { effect, method, idempotency };
  for (const [violated, field, message] of COHERENCE)
    if (violated(facts)) report(at(field), message);

  const scopes = value.required_scopes;
  let requiredScopes: string[] = [];
  if (!Array.isArray(scopes)) report(at("required_scopes"), "must be a list of scopes");
  else if (scopes.length > LIMITS.maxScopes)
    report(at("required_scopes"), `at most ${LIMITS.maxScopes} scopes`);
  else {
    scopes.forEach((scope, index) => {
      if (typeof scope !== "string" || !LIMITS.scopePattern.test(scope))
        report(pointer(at("required_scopes"), index), "must be a scope string");
    });
    const strings = scopes.filter((scope): scope is string => typeof scope === "string");
    if (new Set(strings).size !== strings.length)
      report(at("required_scopes"), "scopes must be unique");
    else if (strings.some((scope, index) => index > 0 && scope < strings[index - 1]!))
      report(at("required_scopes"), "scopes must be sorted");
    requiredScopes = strings;
  }

  const inputSchema = checkSchemaSubset(value.input_schema, at("input_schema"), report, true);
  const outputSchema =
    value.output_schema !== undefined
      ? checkSchemaSubset(value.output_schema, at("output_schema"), report, false)
      : undefined;

  // Every `{param}` of the path is a required scalar input.
  if (endpointPath && inputSchema) {
    const properties = isRecord(inputSchema.properties) ? inputSchema.properties : {};
    const required = new Set(Array.isArray(inputSchema.required) ? inputSchema.required : []);
    for (const [, param] of endpointPath.matchAll(AGENT_MANIFEST_PATH_PARAM)) {
      const property = Object.hasOwn(properties, param!) ? properties[param!] : undefined;
      const type = isRecord(property) ? property.type : undefined;
      if (!required.has(param))
        report(atEndpoint("path"), `path parameter {${param}} must be a required input property`);
      else if (!["string", "integer", "number", "boolean"].includes(type as string))
        report(
          atEndpoint("path"),
          `path parameter {${param}} must be a string, integer, number or boolean input property`,
        );
    }
  }

  if (!name || !effect || !idempotency || !method || !endpointPath || !inputSchema)
    return undefined;
  return {
    name,
    ...(description ? { description } : {}),
    effect,
    endpoint: { method, path: endpointPath },
    idempotency,
    ...(header ? { idempotency_header: header } : {}),
    required_scopes: requiredScopes,
    input_schema: inputSchema,
    ...(outputSchema ? { output_schema: outputSchema } : {}),
  };
}

/**
 * Validates a parsed JSON document against `coforge-agent-manifest.v1` and returns the manifest
 * (without its `x-` extension keys) or the problems found, at most `AGENT_MANIFEST_LIMITS.maxProblems`.
 * It reads the document as data only: nothing is fetched, compiled against input or executed.
 */
export function parseAgentManifest(value: unknown): AgentManifestParseResult {
  const problems: AgentManifestProblem[] = [];
  const report: ReportProblem = (path, message) => {
    if (problems.length < LIMITS.maxProblems) problems.push({ path, message });
  };
  const manifest = readManifest(value, report);
  if (problems.length > 0 || !manifest) return { ok: false, problems };
  return { ok: true, manifest };
}

function readManifest(value: unknown, report: ReportProblem): AgentManifest | undefined {
  if (!isRecord(value)) return (report("", "the manifest must be a JSON object"), undefined);
  rejectUnknownKeys(value, KEYS.top, "", report);
  if (value.schema !== AGENT_MANIFEST_SCHEMA_ID)
    report("/schema", `must be exactly "${AGENT_MANIFEST_SCHEMA_ID}"`);
  const name = optionalText(value, "name", "", LIMITS.nameMaxLength, report);
  const description = optionalText(value, "description", "", LIMITS.descriptionMaxLength, report);
  const urlField = (key: "docs_url" | "app_origin") => {
    if (value[key] === undefined) return undefined;
    const problem = httpsUrlProblem(value[key]);
    if (problem) return (report(`/${key}`, problem), undefined);
    return value[key] as string;
  };
  const docsUrl = urlField("docs_url");
  const appOrigin = urlField("app_origin");

  let execution: AgentManifest["execution"] | undefined;
  const raw = value.execution;
  const mode = isRecord(raw)
    ? AGENT_MANIFEST_EXECUTION_MODES.find((item) => item === raw.mode)
    : undefined;
  if (!isRecord(raw)) report("/execution", "must be an object");
  else if (!mode)
    report("/execution/mode", `must be one of ${AGENT_MANIFEST_EXECUTION_MODES.join(", ")}`);
  else if (mode === "http_api") {
    rejectUnknownKeys(raw, KEYS.executionHttpApi, "/execution", report);
    const problem = httpsUrlProblem(raw.base_url);
    if (problem) report("/execution/base_url", problem);
    else if ((raw.base_url as string).includes("?"))
      report("/execution/base_url", "must not have a query");
    else execution = { mode: "http_api", base_url: raw.base_url as string };
  } else {
    rejectUnknownKeys(raw, KEYS.executionLocalCli, "/execution", report);
    if (!isText(raw.command, LIMITS.commandMaxLength) || !LIMITS.commandPattern.test(raw.command))
      report(
        "/execution/command",
        "must be a bare command name (no path separators, whitespace or shell characters)",
      );
    else execution = { mode: "local_cli", command: raw.command };
  }

  const httpApi = mode === "http_api";
  const localCli = mode === "local_cli";

  let boundary: AgentManifest["credential_boundary"];
  if (value.credential_boundary !== undefined) {
    const item = value.credential_boundary;
    if (httpApi) report("/credential_boundary", "is allowed only for execution mode local_cli");
    else if (!isRecord(item)) report("/credential_boundary", "must be an object");
    else {
      rejectUnknownKeys(item, KEYS.credentialBoundary, "/credential_boundary", report);
      if (item.storage !== "per_agent_home")
        report("/credential_boundary/storage", 'must be "per_agent_home"');
      else if (item.forbid_user_home !== true)
        report("/credential_boundary/forbid_user_home", "must be true");
      else boundary = { storage: "per_agent_home", forbid_user_home: true };
    }
  }

  const rawActions = value.actions;
  const actions: AgentManifestAction[] = [];
  if (localCli) {
    if (Array.isArray(rawActions) ? rawActions.length > 0 : rawActions !== undefined)
      report("/actions", "a local_cli manifest declares no actions");
  } else if (!Array.isArray(rawActions)) report("/actions", "must be a list of actions");
  else if (rawActions.length > LIMITS.maxActions)
    report("/actions", `at most ${LIMITS.maxActions} actions`);
  else {
    const seen = new Set<string>();
    rawActions.forEach((item, index) => {
      const at = pointer("/actions", index);
      const action = parseAction(item, at, report);
      if (isRecord(item) && typeof item.name === "string") {
        if (seen.has(item.name)) report(pointer(at, "name"), "action names must be unique");
        seen.add(item.name);
      }
      if (action) actions.push(action);
    });
  }

  let auth: AgentManifest["auth"];
  if (value.auth !== undefined) {
    const item = value.auth;
    if (!isRecord(item)) report("/auth", "must be an object");
    else {
      rejectUnknownKeys(item, KEYS.auth, "/auth", report);
      if (item.type !== "login_with_coforge") report("/auth/type", 'must be "login_with_coforge"');
      else auth = { type: "login_with_coforge" };
    }
  } else if (Array.isArray(rawActions) && rawActions.length > 0 && !localCli)
    report("/auth", 'is required when actions exist: {"type": "login_with_coforge"}');

  if (!execution) return undefined;
  return {
    schema: AGENT_MANIFEST_SCHEMA_ID,
    ...(name ? { name } : {}),
    ...(description ? { description } : {}),
    ...(docsUrl ? { docs_url: docsUrl } : {}),
    ...(appOrigin ? { app_origin: appOrigin } : {}),
    execution,
    ...(boundary ? { credential_boundary: boundary } : {}),
    ...(auth ? { auth } : {}),
    actions,
  };
}
