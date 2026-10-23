import { isRecord } from "#src/internal/json-record";
import { AGENT_MANIFEST_PATH_PARAM, type AgentManifestAction } from "./agent-manifest-types";

/** The pieces of an HTTP request for one action call, before the base URL and headers are added. */
export type AgentManifestRequestParts = {
  /** The endpoint path with every `{param}` filled and percent-encoded. */
  path: string;
  /** Query pairs, in input order; an array input becomes repeated pairs. */
  query: [string, string][];
  /** The endpoint's absolute URL, without the query; present when a `baseUrl` was given. */
  url?: string;
  /** A JSON object for POST, PUT and PATCH; absent for GET and DELETE. */
  body?: Record<string, unknown>;
};

export type AgentManifestRequestResult =
  | ({ ok: true } & AgentManifestRequestParts)
  | { ok: false; message: string };

const scalar = (value: unknown): value is string | number | boolean =>
  typeof value === "string" || typeof value === "number" || typeof value === "boolean";

/**
 * Maps an action's input to the request the manifest spec defines (docs/agent-manifest/actions.md):
 * `{name}` path parameters come from the same-named input property and are percent-encoded per
 * segment; for GET and DELETE the other top-level properties become the query, for POST, PUT and
 * PATCH they become a JSON object body. A path parameter is never repeated in the query or body.
 * With `baseUrl`, the result also carries the absolute `url`, and a path that would move the request
 * off `baseUrl`'s origin fails, so a caller cannot forget the check.
 * Pure: it validates the shape only, not the input against the schema.
 */
export function buildActionRequest(
  action: Pick<AgentManifestAction, "endpoint">,
  input: unknown,
  baseUrl?: string,
): AgentManifestRequestResult {
  const built = buildParts(action, input);
  if (!built.ok || baseUrl === undefined) return built;
  try {
    const base = baseUrl.replace(/\/+$/, "");
    const url = new URL(built.path === "/" ? baseUrl : `${base}${built.path}`);
    if (url.origin !== new URL(baseUrl).origin)
      return { ok: false, message: "the request would leave the app's API origin" };
    return { ...built, url: url.href };
  } catch {
    return { ok: false, message: "the app's base_url and the path do not form a URL" };
  }
}

function buildParts(
  action: Pick<AgentManifestAction, "endpoint">,
  input: unknown,
): AgentManifestRequestResult {
  if (!isRecord(input)) return { ok: false, message: "the input must be a JSON object" };
  const used = new Set<string>();
  let failure: string | undefined;
  const path = action.endpoint.path.replace(AGENT_MANIFEST_PATH_PARAM, (_, name: string) => {
    const value = Object.hasOwn(input, name) ? input[name] : undefined;
    if (!scalar(value) || (typeof value === "number" && !Number.isFinite(value))) {
      failure ??= `path parameter ${name} must be a string, number or boolean input`;
      return "";
    }
    const text = String(value);
    if (text === "" || /^\.{1,2}$/.test(text)) {
      failure ??= `path parameter ${name} must not be empty, "." or ".."`;
      return "";
    }
    used.add(name);
    return encodeURIComponent(text);
  });
  if (failure) return { ok: false, message: failure };
  const rest = Object.entries(input).filter(([name]) => !used.has(name));
  if (["POST", "PUT", "PATCH"].includes(action.endpoint.method))
    return { ok: true, path, query: [], body: Object.fromEntries(rest) };
  const query: [string, string][] = [];
  for (const [name, value] of rest) {
    if (value === null || value === undefined) continue;
    const items = Array.isArray(value) ? value : [value];
    for (const item of items) {
      if (!scalar(item))
        return { ok: false, message: `input ${name} cannot be sent in a query string` };
      query.push([name, String(item)]);
    }
  }
  return { ok: true, path, query };
}
