import { agentApiRoutes, type AgentAppRequest } from "@lrm/coforge-sdk/agent";

/** The cloud request `coforge app list|token` becomes: a token request carries a JSON `body` with
 * the target and scopes the Agent gave (an absent one stays absent, an empty `scopes` stays empty). */
export function agentAppCloudRequest(request: AgentAppRequest): {
  method: string;
  path: string;
  body?: string;
} {
  const { list, token } = agentApiRoutes.cloud.apps;
  if (request.operation === "list") return { method: list.method, path: list.path };
  return {
    method: token.method,
    path: token.path(request.appKey),
    body: JSON.stringify({ target: request.target, scopes: request.scopes }),
  };
}
