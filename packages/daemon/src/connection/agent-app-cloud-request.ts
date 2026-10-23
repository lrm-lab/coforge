import {
  agentApiRoutes,
  type AgentAppManagementRequest,
  type AgentAppRequest,
} from "@lrm/coforge-sdk/agent";

type CloudRequest = { method: string; path: string; body?: string };

/** The cloud request an Agent's app-management operation becomes: the route named like the
 * operation, with the operation's own fields as the JSON body (none for a bodyless route). */
function managementCloudRequest(request: AgentAppManagementRequest): CloudRequest {
  const routes = agentApiRoutes.cloud.appRegistrations;
  const at = (route: { method: string; path: (clientKey: string) => string }, body?: object) => ({
    method: route.method,
    path: route.path(request.clientKey),
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  switch (request.operation) {
    case "rotate_secret":
      return at(routes.rotateSecret);
    case "update":
      return at(routes.update, request.changes);
    case "delete":
      return at(routes.delete);
    case "logo_set":
      return at(routes.logoSet, {
        contentType: request.contentType,
        dataBase64: request.dataBase64,
      });
    case "logo_clear":
      return at(routes.logoClear);
    case "transfer_owner":
      return at(routes.transferOwner, { toAgent: request.toAgent });
    case "share_link_create":
      return at(routes.shareLinkCreate, { expiresDays: request.expiresDays });
    case "share_link_status":
      return at(routes.shareLinkStatus);
    case "share_link_revoke":
      return at(routes.shareLinkRevoke);
    case "request_publish":
      return at(routes.requestPublish);
    case "request_unpublish":
      return at(routes.requestUnpublish);
  }
}

/** The cloud request `coforge app list|token|status|rotate-secret|update|...` becomes: a token
 * request carries a JSON `body` with the target and scopes the Agent gave (an absent one stays
 * absent, an empty `scopes` stays empty); a status names its card or app in the query. */
export function agentAppCloudRequest(request: AgentAppRequest): CloudRequest {
  const { list, token } = agentApiRoutes.cloud.apps;
  const { status, owned } = agentApiRoutes.cloud.appRegistrations;
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
    default:
      return managementCloudRequest(request);
  }
}
