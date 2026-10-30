import type { AgentProxyRuntime } from "./agent-proxy-runtime";

/** What a Local Proxy token stands for: the Agent, its runtime context and its Agent API key. */
export type TokenBinding = {
  agentId: string;
  context: string;
  agentApiKey: string;
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
   * validator errors — those are classified by the dispatcher like any other failure. */
  parse(input: {
    request: Request;
    url: URL;
    param: string;
    /** The parsed body of a `json` route. */
    payload: unknown;
    /** The parsed body of a `json-object` route; empty otherwise. */
    fields: JsonObject;
    binding: TokenBinding;
  }): RequestOf<K> | Response;
  /** Defaults to `Response.json(result)`. */
  respond?(result: ResultOf<K>): Response;
  /** A domain error this route answers itself instead of the classified proxy failure. */
  domainFailure?(error: unknown): Response | undefined;
};

/** Type-checks one route entry against its own runtime method while keeping the table homogeneous. */
export function defineRoute<K extends HandlerName>(route: ProxyRoute<K>): ProxyRoute {
  return route as unknown as ProxyRoute;
}
