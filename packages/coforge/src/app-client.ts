import {
  agentApiRoutes,
  decodeAgentAppErrorResponse,
  decodeAgentAppListResponse,
  decodeAgentAppTokenResponse,
  type AgentAppListResponse,
  type AgentAppTokenResponse,
} from "@lrm/coforge-sdk/agent";
import { envelopeRequest } from "./proxy-request";

/** `coforge app list|token`'s requests, through the daemon's local proxy. */
export type AppClient = {
  appList(): Promise<AgentAppListResponse>;
  appToken(appKey: string, target?: string): Promise<AgentAppTokenResponse>;
};

export function connectAppClient(context: string, proxyUrl: string): AppClient {
  const endpoint = (path: string) => {
    const url = new URL(proxyUrl);
    url.pathname = path;
    url.search = "";
    return url;
  };
  const { list, token } = agentApiRoutes.local.apps;
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
    // No idempotency key: asking again is harmless, since a waiting request (and its card) is
    // never made twice.
    appToken: (appKey, target) =>
      envelopeRequest(
        endpoint,
        context,
        proxyUrl,
        {
          method: token.method,
          path: token.path(appKey),
          body: target ? { target } : {},
        },
        decodeAgentAppTokenResponse,
        decodeAgentAppErrorResponse,
        "app-token",
      ),
  };
}
