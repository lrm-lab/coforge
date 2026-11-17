import {
  agentApiRoutes,
  createAgentApiClient,
  type AgentAppListResponse,
  type AgentAppMarketplaceResponse,
  type AgentAppTokenResponse,
} from "@lrm/coforge-sdk/agent";
import { createAppProxyAgentApiTransport } from "./sdk-proxy-transport";

/** `coforge app list|token|marketplace`'s requests, through the daemon's local proxy. */
export type AppClient = {
  appList(): Promise<AgentAppListResponse>;
  appToken(appKey: string, target?: string, scopes?: string[]): Promise<AgentAppTokenResponse>;
  appMarketplace(query?: string, limit?: number): Promise<AgentAppMarketplaceResponse>;
};

export function connectAppClient(context: string, proxyUrl: string): AppClient {
  const { list, marketplace } = agentApiRoutes.local.apps;
  const client = createAgentApiClient(
    createAppProxyAgentApiTransport(context, proxyUrl, (route) => {
      if (route.path === list.path) return "app-list";
      if (route.path === marketplace.path) return "app-marketplace";
      return "app-token";
    }),
  );
  return {
    appList: () => client.apps.list(),
    appMarketplace: (query, limit) => client.apps.marketplace({ query, limit }),
    // No idempotency key: asking again is harmless, since a waiting request (and its card) is
    // never made twice.
    appToken: (appKey, target, scopes) => client.apps.token(appKey, { target, scopes }),
  };
}
