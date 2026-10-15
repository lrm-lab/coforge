import { createFileRoute } from "@tanstack/react-router";
import { agentAuthMiddleware } from "#src/server/agents/agent-http-middleware.server";
import {
  AgentChannelManagement,
  type AgentChannelManagementRepository,
} from "#src/server/conversations/agent-channel-management.server";
import {
  handleAgentChannelArchiveStatePost,
  type AgentChannelManagementPrincipal,
} from "#src/server/agents/agent-channel-routes.server";

export async function handleAgentChannelArchivePost(
  request: Request,
  channel: string,
  principal: AgentChannelManagementPrincipal,
  repository: AgentChannelManagementRepository,
): Promise<Response> {
  return handleAgentChannelArchiveStatePost(request, channel, principal, repository, true);
}

export const Route = createFileRoute("/api/agent/v1/channels_/$channel/archive")({
  server: {
    middleware: [agentAuthMiddleware],
    handlers: {
      POST: ({ request, context: { principal, db }, params }) =>
        handleAgentChannelArchivePost(
          request,
          params.channel,
          principal,
          new AgentChannelManagement(db),
        ),
    },
  },
});
