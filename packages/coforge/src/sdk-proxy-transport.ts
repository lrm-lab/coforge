import {
  decodeAgentAppErrorResponse,
  type AgentApiResult,
  type AgentApiTransport,
} from "@lrm/coforge-sdk/agent";
import { artifactNetworkFailure, artifactRefusal, type ArtifactCall } from "#src/artifact-failure";
import { envelopeRequest, proxyEndpointOf, requireProxySetup } from "#src/proxy-request";

type RouteObject = { method: string; path: string };

function resolveRoute(route: unknown): RouteObject {
  if (
    route &&
    typeof route === "object" &&
    "method" in route &&
    "path" in route &&
    typeof (route as RouteObject).method === "string" &&
    typeof (route as RouteObject).path === "string"
  ) {
    return route as RouteObject;
  }
  throw new Error("Unsupported Agent API route descriptor");
}

/**
 * Adapts the local daemon proxy's app envelope contract (`{ ok: false, errorCode, error }`)
 * into `AgentApiTransport` so `app-client`, `app-registration-client`, and `app-management-client`
 * call typed methods on `createAgentApiClient` while preserving `CliError` classification.
 */
export function createAppProxyAgentApiTransport(
  context: string,
  proxyUrl: string,
  operationFor: (route: RouteObject, input: unknown) => string,
): AgentApiTransport {
  const endpoint = proxyEndpointOf(proxyUrl);
  return {
    async request(rawRoute: unknown, input?: unknown): Promise<AgentApiResult<unknown>> {
      const route = resolveRoute(rawRoute);
      const isGet = route.method.toUpperCase() === "GET";
      const data = await envelopeRequest(
        endpoint,
        context,
        proxyUrl,
        {
          method: route.method,
          path: route.path,
          ...(isGet && input && typeof input === "object"
            ? { query: input as Record<string, string> }
            : {}),
          ...(!isGet && input !== undefined ? { body: input } : {}),
        },
        (raw) => raw,
        decodeAgentAppErrorResponse,
        operationFor(route, input),
      );
      return { ok: true, status: 200, data };
    },
  };
}

/**
 * Adapts the local daemon proxy's artifact contract (30s lock timeout + `artifactRefusal`)
 * into `AgentApiTransport` for `createAgentApiClient(...).artifacts.execute(...)`.
 */
export function createArtifactProxyAgentApiTransport(
  proxyEndpoint: (path: string) => URL,
  context: string,
  proxyUrl: string,
  call: ArtifactCall,
): AgentApiTransport {
  return {
    async request(rawRoute: unknown, input?: unknown): Promise<AgentApiResult<unknown>> {
      requireProxySetup("artifact", context, proxyUrl);
      const route = resolveRoute(rawRoute);
      let response: Response;
      try {
        response = await fetch(proxyEndpoint(route.path), {
          method: route.method,
          headers: { authorization: `Bearer ${context}`, "content-type": "application/json" },
          body: JSON.stringify(input),
          // A push may wait behind others' pushes of the artifact, under the server's row lock.
          signal: AbortSignal.timeout(30_000),
        });
      } catch {
        throw artifactNetworkFailure("agent artifact request failed (network or timeout)", call);
      }
      if (!response.ok) throw await artifactRefusal(response, call);
      return { ok: true, status: response.status, data: await response.json() };
    },
  };
}
