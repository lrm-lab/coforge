import {
  agentApiRoutes,
  decodeAgentAppConfigErrorResponse,
  decodeAgentAppConfigResponse,
  type AgentAppConfigPatch,
  type AgentAppConfigResponse,
} from "@lrm/coforge-sdk/agent";
import type { AppConfigTransport } from "#src/app-config";
import { envelopeRequest } from "#src/proxy-request";

/** `coforge app config` through the daemon's proxy: read one of the Agent's own Apps' config,
 * and change it. */
export const appConfigRequests = (
  proxyEndpoint: (path: string) => URL,
  context: string,
  proxyUrl: string,
): Required<AppConfigTransport> => ({
  appConfigGet: (appId: string): Promise<AgentAppConfigResponse> =>
    envelopeRequest(
      proxyEndpoint,
      context,
      proxyUrl,
      {
        method: agentApiRoutes.local.appConfig.get.method,
        path: agentApiRoutes.local.appConfig.get.path(appId),
      },
      decodeAgentAppConfigResponse,
      decodeAgentAppConfigErrorResponse,
      "app-config",
    ),
  // One key per invocation. A repeat cannot apply twice either way: the cloud refuses any
  // change not made against the current revision.
  appConfigUpdate: (appId: string, change: AgentAppConfigPatch): Promise<AgentAppConfigResponse> =>
    envelopeRequest(
      proxyEndpoint,
      context,
      proxyUrl,
      {
        method: agentApiRoutes.local.appConfig.update.method,
        path: agentApiRoutes.local.appConfig.update.path(appId),
        body: { ...change, idempotencyKey: crypto.randomUUID() },
      },
      decodeAgentAppConfigResponse,
      decodeAgentAppConfigErrorResponse,
      "app-config",
    ),
});
