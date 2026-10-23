import { agentApiRoutes, type AgentAppRequest } from "@lrm/coforge-sdk/agent";

/** The cloud request `coforge app list|token|status|rotate-secret` becomes: a token request
 * carries a JSON `body` with the target and scopes the Agent gave (an absent one stays absent, an
 * empty `scopes` stays empty); a status names its card or app in the query. */
export function agentAppCloudRequest(request: AgentAppRequest): {
  method: string;
  path: string;
  body?: string;
} {
  const { list, token } = agentApiRoutes.cloud.apps;
  const { status, owned, rotateSecret } = agentApiRoutes.cloud.appRegistrations;
  switch (request.operation) {
    case "list":
      return { method: list.method, path: list.path };
    case "token":
      return {
        method: token.method,
        path: token.path(request.appKey),
        body: JSON.stringify({ target: request.target, scopes: request.scopes }),
      };
    case "register_status": {
      const query = new URLSearchParams(
        request.card ? { card: request.card } : { client: request.client ?? "" },
      );
      return { method: status.method, path: `${status.path}?${query}` };
    }
    case "owned_list":
      return { method: owned.method, path: owned.path };
    case "rotate_secret":
      return { method: rotateSecret.method, path: rotateSecret.path(request.clientKey) };
  }
}
