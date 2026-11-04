import type { AgentProxyRuntime } from "./agent-proxy-runtime";
import { AgentPreflightError } from "#src/daemon-runtime/agent-preflight-error";

/** A family that names the payload's `operation`, e.g. `agent-api/channel-info`. */
export function operationFamily(prefix: string, fallback: string) {
  return (fields: JsonObject) =>
    `${prefix}${typeof fields.operation === "string" ? fields.operation : fallback}`;
}

/** The first of `routes` whose method and pathname match, along with the path param `match` found. */
export function findProxyRoute(
  routes: readonly ProxyRoute[],
  method: string,
  pathname: string,
): { route: ProxyRoute; param: string } | undefined {
  for (const route of routes) {
    if (route.method !== method) continue;
    const param = route.match(pathname);
    if (param !== undefined) return { route, param };
  }
  return undefined;
}

/** What a Local Proxy token stands for: the Agent and its runtime context. The Agent API key
 * is not bound here — each request resolves the Agent's current key from the daemon's key
 * registry, so a key rotated after `issue` still reaches a running process. */
export type TokenBinding = {
  agentId: string;
  context: string;
  memoryFence?: string;
};
export type JsonObject = Record<string, unknown>;

/**
 * How the dispatcher reads the request body before `parse` runs.
 * - `none`: no body read (GET/DELETE, and the multipart upload, which streams `request` through).
 * - `json`: size-limited JSON of any shape, no content-type requirement (upload-session create).
 * - `json-object`: requires `content-type: application/json` (else 415) and a plain object (else
 *   400); `freshnessContextMode: "withheld"` on it turns on reviewer redaction.
 */
export type BodyRead = "none" | "json" | "json-object";

/** The runtime methods a route can dispatch to; each takes `(context, request, agentApiKey)`. */
export type HandlerName = Exclude<keyof AgentProxyRuntime, "issueAgentContext" | "memoryFence">;
export type RuntimeHandler<K extends HandlerName> = NonNullable<AgentProxyRuntime[K]>;
export type RequestOf<K extends HandlerName> = Parameters<RuntimeHandler<K>>[1];
export type ResultOf<K extends HandlerName> = Awaited<ReturnType<RuntimeHandler<K>>>;

/** What a route's `parse` receives: the request plus the body the dispatcher already read. */
export type RouteParseInput = {
  request: Request;
  url: URL;
  param: string;
  /** The parsed body of a `json` route. */
  payload: unknown;
  /** The parsed body of a `json-object` route; empty otherwise. */
  fields: JsonObject;
  binding: TokenBinding;
};

export type ProxyRoute<K extends HandlerName = HandlerName> = {
  /** `route_family` on a classified failure; a function when it depends on `operation`. */
  family: string | ((fields: JsonObject) => string);
  method: string;
  /** The path param (or `""` when the route has none) if the pathname belongs to this route. Must
   * not throw: a param that needs decoding is decoded in `parse`. */
  match(pathname: string): string | undefined;
  body: BodyRead;
  /** Override the default JSON body size cap (Collect packs need a larger limit). */
  maxBodyBytes?: number;
  /** The runtime method this route calls. The dispatcher looks it up, answers 404 when the runtime
   * lacks it, and always calls it with the token-bound context and Agent API key. */
  handler: K;
  /** Validates and builds the runtime request. Return a Response to reject (400/413). May throw
   * validator errors — `parseRouteRequest` turns those into a local precondition. */
  parse(input: RouteParseInput): RequestOf<K> | Response;
  /** Defaults to `Response.json(result)`. */
  respond?(result: ResultOf<K>): Response;
  /** A domain error this route answers itself instead of the classified proxy failure. */
  domainFailure?(error: unknown): Response | undefined;
};

/** Type-checks one route entry against its own runtime method while keeping the table homogeneous. */
export function defineRoute<K extends HandlerName>(route: ProxyRoute<K>): ProxyRoute {
  return route as unknown as ProxyRoute;
}

/**
 * Runs one route's `parse`. A validator error is the caller's own invalid request, so it becomes a
 * local precondition (400, the original message) instead of a fabricated upstream failure. A parse
 * that already classified itself keeps its own code and verdict.
 */
export function parseRouteRequest<K extends HandlerName>(
  parse: (input: RouteParseInput) => RequestOf<K> | Response,
  input: RouteParseInput,
): RequestOf<K> | Response {
  try {
    return parse(input);
  } catch (error) {
    if (error instanceof AgentPreflightError) throw error;
    throw new AgentPreflightError(
      error instanceof Error && error.message ? error.message : "invalid proxy request",
      "INVALID_INPUT",
      { retryable: false },
    );
  }
}
