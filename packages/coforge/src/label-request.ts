import {
  agentApiRoutes,
  decodeAgentLabelListResponse,
  type AgentLabelListResponse,
} from "@lrm/coforge-sdk/agent";
import { envelopeRequest } from "./proxy-request";

/** `coforge label list` through the daemon's proxy: the Workspace's labels. */
export function labelListRequest(
  proxyEndpoint: (path: string) => URL,
  context: string,
  proxyUrl: string,
): Promise<AgentLabelListResponse> {
  return envelopeRequest(
    proxyEndpoint,
    context,
    proxyUrl,
    agentApiRoutes.local.labels,
    decodeAgentLabelListResponse,
    () => undefined,
    "label-list",
  );
}
