import {
  agentApiRoutes,
  decodeAgentAttachmentCommentsErrorResponse,
  decodeAgentAttachmentCommentsResponse,
  type AgentAttachmentCommentsRequest,
  type AgentAttachmentCommentsResponse,
} from "@lrm/coforge-sdk/agent";
import { envelopeRequest } from "./proxy-request";

/** `attachment comments`: the root comments on one attachment. */
export function attachmentCommentsRequest(
  proxyEndpoint: (path: string) => URL,
  context: string,
  proxyUrl: string,
  { attachmentId, limit, before }: AgentAttachmentCommentsRequest,
): Promise<AgentAttachmentCommentsResponse> {
  return envelopeRequest(
    proxyEndpoint,
    context,
    proxyUrl,
    {
      method: agentApiRoutes.local.attachmentComments.method,
      path: agentApiRoutes.local.attachmentComments.path(attachmentId),
      query: {
        ...(limit === undefined ? {} : { limit: String(limit) }),
        ...(before === undefined ? {} : { before: String(before) }),
      },
    },
    decodeAgentAttachmentCommentsResponse,
    decodeAgentAttachmentCommentsErrorResponse,
    "comments",
  );
}
