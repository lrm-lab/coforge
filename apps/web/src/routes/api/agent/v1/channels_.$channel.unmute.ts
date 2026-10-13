import { createFileRoute } from "@tanstack/react-router";
import { agentAuthMiddleware } from "#src/server/agents/agent-http-middleware.server";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";
import type { AgentMessageRepository } from "#src/server/agents/agent-messages.server";
import { handleAgentChannelMutePost } from "./channels_.$channel.mute";
import type { AgentChannelManagementPrincipal } from "#src/server/agents/agent-channel-routes.server";

/** `mute` with `muted: false`; kept as its own route so `coforge channel unmute` has a path. */
export function handleAgentChannelUnmutePost(
  request: Request,
  channel: string,
  principal: AgentChannelManagementPrincipal,
  repository: AgentMessageRepository,
): Promise<Response> {
  return handleAgentChannelMutePost(request, channel, false, principal, repository);
}

export const Route = createFileRoute("/api/agent/v1/channels_/$channel/unmute")({
  server: {
    middleware: [agentAuthMiddleware],
    handlers: {
      POST: ({ request, context: { principal, db }, params }) =>
        handleAgentChannelUnmutePost(
          request,
          params.channel,
          principal,
          new PrismaDirectConversationRepository(db),
        ),
    },
  },
});
