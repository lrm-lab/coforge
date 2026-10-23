import {
  AGENT_MANIFEST_LIMITS as LIMITS,
  AGENT_MANIFEST_PATH_PARAM_NAME,
  type AgentManifest,
  type AgentManifestProblem,
} from "./agent-manifest-types";

/** Headers an action must never name as its idempotency header: credentials and hop-by-hop ones. */
const DENIED_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
  "upgrade",
  "te",
  "trailer",
  "keep-alive",
]);

/** Why `name` may not carry an idempotency key, or `undefined` when it may. */
export function deniedIdempotencyHeader(name: string): string | undefined {
  const lower = name.toLowerCase();
  if (DENIED_HEADERS.has(lower) || lower.startsWith("x-coforge-"))
    return `"${name}" is a credential, hop-by-hop or CoForge header and cannot carry an idempotency key`;
  return undefined;
}

/** What a path may hold: URL path characters and `{param}` placeholders, never whitespace. */
const PATH_CHARACTERS = new RegExp(`^${LIMITS.pathCharacters}+$`);
const WHOLE_PARAM = new RegExp(`^\\{${AGENT_MANIFEST_PATH_PARAM_NAME}\\}$`);

/** Why an endpoint path is not acceptable, or `undefined` when it is. */
export function checkEndpointPath(path: unknown): string | undefined {
  if (typeof path !== "string" || path.length > LIMITS.pathMaxLength)
    return `must be a string of at most ${LIMITS.pathMaxLength} characters`;
  if (!path.startsWith("/") || path.startsWith("//")) return 'must start with a single "/"';
  if (!PATH_CHARACTERS.test(path))
    return "may hold only URL path characters (no query, fragment, credentials or whitespace)";
  if (/%(?![0-9A-Fa-f]{2})/.test(path)) return "has an invalid percent-encoding";
  if (/%(2f|5c)/i.test(path)) return "must not encode a path separator (%2F or %5C)";
  if (path === "/") return undefined;
  const segments = path.slice(1).split("/");
  if (segments.some((segment) => segment === "")) return "must not have empty segments";
  if (segments.some((segment) => /^(\.|%2e){1,2}$/i.test(segment)))
    return 'must not contain "." or ".." segments';
  if (segments.some((segment) => /[{}]/.test(segment) && !WHOLE_PARAM.test(segment)))
    return "every {param} must be a whole path segment with a valid name and balanced braces";
  return undefined;
}

/**
 * Why `raw` is not an acceptable manifest-related URL, or `undefined` when it is: an absolute https
 * URL of at most `urlMaxLength` characters, without credentials or a fragment. One rule for every
 * URL field of the manifest and for the URL the CLI fetches it from (and each redirect hop).
 */
export function httpsUrlProblem(raw: unknown): string | undefined {
  if (typeof raw !== "string" || raw.length < 1 || raw.length > LIMITS.urlMaxLength)
    return `must be a URL of at most ${LIMITS.urlMaxLength} characters`;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "must be an absolute URL";
  }
  if (url.protocol !== "https:") return "must be an https URL";
  if (url.username || url.password) return "must not carry credentials";
  if (url.hash) return "must not have a fragment";
  return undefined;
}

/** At use time an `http_api` manifest's `base_url` must share an origin with the app's homepage or
 * with the manifest URL, so a manifest cannot point an Agent at an unrelated host. */
export function checkBaseUrlOrigin(
  manifest: AgentManifest,
  app: { homepageUrl: string | null; manifestUrl: string },
): AgentManifestProblem | undefined {
  if (manifest.execution.mode !== "http_api") return undefined;
  const origin = (raw: string | null) => {
    try {
      return raw ? new URL(raw).origin : undefined;
    } catch {
      return undefined;
    }
  };
  const baseOrigin = origin(manifest.execution.base_url);
  if (baseOrigin === origin(app.homepageUrl) || baseOrigin === origin(app.manifestUrl))
    return undefined;
  return {
    path: "/execution/base_url",
    message: `the API origin ${baseOrigin ?? "(none)"} is neither the app homepage's nor the manifest URL's origin`,
  };
}
