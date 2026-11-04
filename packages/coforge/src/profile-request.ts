import {
  agentApiRoutes,
  decodeAgentProfileErrorResponse,
  decodeAgentProfileShowResponse,
  decodeAgentProfileUpdateResponse,
  decodeAgentUserInfoErrorResponse,
  decodeAgentUserInfoResponse,
  type AgentProfileShowResponse,
  type AgentProfileUpdateRequest,
  type AgentProfileUpdateResponse,
  type AgentUserInfoResponse,
} from "@lrm/coforge-sdk/agent";
import { envelopeRequest } from "./proxy-request";

/** `coforge user info` and `coforge profile show|update` through the daemon's proxy: who a
 * Workspace member is, and who the calling Agent is. */
export const profileRequests = (
  proxyEndpoint: (path: string) => URL,
  context: string,
  proxyUrl: string,
) => ({
  userInfo: (name: string): Promise<AgentUserInfoResponse> =>
    envelopeRequest(
      proxyEndpoint,
      context,
      proxyUrl,
      {
        method: agentApiRoutes.local.users.method,
        path: agentApiRoutes.local.users.path(name),
      },
      decodeAgentUserInfoResponse,
      decodeAgentUserInfoErrorResponse,
      "user-info",
    ),
  profileShow: (target?: string): Promise<AgentProfileShowResponse> =>
    envelopeRequest(
      proxyEndpoint,
      context,
      proxyUrl,
      { ...agentApiRoutes.local.profile.get, query: target ? { target } : {} },
      decodeAgentProfileShowResponse,
      decodeAgentProfileErrorResponse,
      "profile-show",
    ),
  profileUpdate: (input: AgentProfileUpdateRequest): Promise<AgentProfileUpdateResponse> =>
    envelopeRequest(
      proxyEndpoint,
      context,
      proxyUrl,
      { ...agentApiRoutes.local.profile.update, body: input },
      decodeAgentProfileUpdateResponse,
      decodeAgentProfileErrorResponse,
      "profile-update",
    ),
});
