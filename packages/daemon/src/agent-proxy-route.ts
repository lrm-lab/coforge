import type { AgentProxyRuntime } from "./agent-proxy-runtime";
import { AgentPreflightError } from "#src/daemon-runtime/agent-preflight-error";
export function operationFamily(prefix: string, fallback: string) {
  return (fields: JsonObject) =>
    `${prefix}${typeof fields.operation === "string" ? fields.operation : fallback}`;
}
export function findProxyRoute(
  routes: readonly ProxyRoute[],
  method: string,
  pathname: string,
):
  | {
      route: ProxyRoute;
      param: string;
    }
  | undefined {
  for (const route of routes) {
    if (route.method !== method) continue;
    const param = route.match(pathname);
    if (param !== undefined) return { route, param };
  }
  return undefined;
}
export type TokenBinding = {
  agentId: string;
  context: string;
};
export type JsonObject = Record<string, unknown>;
export type BodyRead = "none" | "json" | "json-object";
export type HandlerName = Exclude<keyof AgentProxyRuntime, "issueAgentContext" | "memoryFence">;
export type RuntimeHandler<K extends HandlerName> = NonNullable<AgentProxyRuntime[K]>;
export type RequestOf<K extends HandlerName> = Parameters<RuntimeHandler<K>>[1];
export type ResultOf<K extends HandlerName> = Awaited<ReturnType<RuntimeHandler<K>>>;
export type RouteParseInput = {
  request: Request;
  url: URL;
  param: string;
  payload: unknown;
  fields: JsonObject;
  binding: TokenBinding;
};
export type ProxyRoute<K extends HandlerName = HandlerName> = {
  family: string | ((fields: JsonObject) => string);
  method: string;
  match(pathname: string): string | undefined;
  body: BodyRead;
  maxBodyBytes?: number;
  handler: K;
  parse(input: RouteParseInput): RequestOf<K> | Response;
  respond?(result: ResultOf<K>): Response;
  domainFailure?(error: unknown): Response | undefined;
};
export function defineRoute<K extends HandlerName>(route: ProxyRoute<K>): ProxyRoute {
  return route as unknown as ProxyRoute;
}
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
