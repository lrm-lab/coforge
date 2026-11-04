import {
  agentApiRoutes,
  decodeAgentAppErrorResponse,
  decodeAgentAppListResponse,
  decodeAgentAppMarketplaceResponse,
  decodeAgentAppTokenResponse,
  type AgentAppListResponse,
  type AgentAppMarketplaceResponse,
  type AgentAppTokenResponse,
} from "@lrm/coforge-sdk/agent";
import { envelopeRequest } from "./proxy-request";

/** `coforge app list|token|marketplace`'s requests, through the daemon's local proxy. */
export type AppClient = {
  appList(): Promise<AgentAppListResponse>;
  appToken(appKey: string, target?: string, scopes?: string[]): Promise<AgentAppTokenResponse>;
  appMarketplace(query?: string, limit?: number): Promise<AgentAppMarketplaceResponse>;
};

export function connectAppClient(context: string, proxyUrl: string): AppClient {
  const endpoint = (path: string) => {
    const url = new URL(proxyUrl);
    url.pathname = path;
    url.search = "";
    return url;
  };
  const { list, token, marketplace } = agentApiRoutes.local.apps;
  return {
    appList: () =>
      envelopeRequest(
        endpoint,
        context,
        proxyUrl,
        list,
        decodeAgentAppListResponse,
        decodeAgentAppErrorResponse,
        "app-list",
      ),
    appMarketplace: (query, limit) =>
      envelopeRequest(
        endpoint,
        context,
        proxyUrl,
        {
          method: marketplace.method,
          path: marketplace.path,
          query: {
            ...(query === undefined ? {} : { query }),
            ...(limit === undefined ? {} : { limit: String(limit) }),
          },
        },
        decodeAgentAppMarketplaceResponse,
        decodeAgentAppErrorResponse,
        "app-marketplace",
      ),
    // No idempotency key: asking again is harmless, since a waiting request (and its card) is
    // never made twice.
    appToken: (appKey, target, scopes) =>
      envelopeRequest(
        endpoint,
        context,
        proxyUrl,
        {
          method: token.method,
          path: token.path(appKey),
          body: { ...(target ? { target } : {}), ...(scopes ? { scopes } : {}) },
        },
        decodeAgentAppTokenResponse,
        decodeAgentAppErrorResponse,
        "app-token",
      ),
  };
}
