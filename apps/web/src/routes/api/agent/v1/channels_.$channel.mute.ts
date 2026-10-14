import { createFileRoute } from "@tanstack/react-router";
import type { AgentChannelAttentionResponse } from "@lrm/coforge-sdk/agent";
import { agentAuthMiddleware } from "#src/server/agents/agent-http-middleware.server";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";
import {
  muteAgentChannel,
  type AgentMessageRepository,
} from "#src/server/agents/agent-messages.server";
import {
  agentIdempotencyKey,
  agentRouteErrorResponse,
  readAgentJsonBody,
} from "#src/server/agents/agent-http-routes.server";
import type { AgentChannelManagementPrincipal } from "#src/server/agents/agent-channel-routes.server";

/** Mutes (`muted`) or unmutes a channel for the calling Agent; `unmute` is this with `false`. */
export async function handleAgentChannelMutePost(
  request: Request,
  channel: string,
  muted: boolean,
  principal: AgentChannelManagementPrincipal,
  repository: AgentMessageRepository,
): Promise<Response> {
  const scope = { workspaceId: principal.workspaceId, agentId: principal.agentId };
  try {
    const idempotencyKey = agentIdempotencyKey(await readAgentJsonBody(request));
    await muteAgentChannel(repository, scope, channel, muted);
    const response: AgentChannelAttentionResponse = {
      idempotencyKey,
      target: channel,
      muted,
    };
    return Response.json(response);
  } catch (error) {
    return agentRouteErrorResponse(error, muted ? "channel mute failed" : "channel unmute failed", [
      "mute requires a channel target",
    ]);
  }
}

export const Route = createFileRoute("/api/agent/v1/channels_/$channel/mute")({
  server: {
    middleware: [agentAuthMiddleware],
    handlers: {
      POST: ({ request, context: { principal, db }, params }) =>
        handleAgentChannelMutePost(
          request,
          params.channel,
          true,
          principal,
          new PrismaDirectConversationRepository(db),
        ),
    },
  },
});
