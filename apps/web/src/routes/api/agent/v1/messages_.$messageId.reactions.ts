import { createFileRoute } from "@tanstack/react-router";
import { isAppError } from "#src/lib/app-error";
import { agentMessageReactionRepository } from "#src/server/agents/agent-message-reactions.server";
import type { AgentReactionResponse } from "@lrm/coforge-sdk/agent";
import { agentAuthMiddleware } from "#src/server/agents/agent-http-middleware.server";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";
import { createCentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import { CentrifugoConversationRealtime } from "#src/server/conversations/conversation-realtime.server";
import type { PrismaClient } from "#src/generated/prisma/client";
import {
  reactToAgentMessage,
  type AgentMessageRepository,
} from "#src/server/agents/agent-messages.server";
import {
  agentIdempotencyKey,
  agentRouteErrorResponse,
  agentRouteDomainErrorResponse,
  readAgentJsonBody,
} from "#src/server/agents/agent-http-routes.server";

export type AgentMessageReactionPrincipal = { workspaceId: string; agentId: string };

export async function handleAgentMessageReaction(
  request: Request,
  messageId: string,
  active: boolean,
  principal: AgentMessageReactionPrincipal,
  repository: AgentMessageRepository,
): Promise<Response> {
  const scope = { workspaceId: principal.workspaceId, agentId: principal.agentId };
  try {
    const body = await readAgentJsonBody(request);
    const idempotencyKey = agentIdempotencyKey(body);
    const emoji = typeof body?.emoji === "string" ? body.emoji : "";
    const result = await reactToAgentMessage(repository, scope, messageId, emoji, active);
    const response: AgentReactionResponse = {
      idempotencyKey,
      messageId: result.messageId,
      emoji,
      active,
    };
    return Response.json(response);
  } catch (error) {
    return isAppError(error)
      ? agentRouteDomainErrorResponse(error, "message reaction failed")
      : agentRouteErrorResponse(error, "message reaction failed");
  }
}

/** Ordinary reactions announce to open pages; comment reactions use AttachmentComments. */
function agentReactionRepository(db: PrismaClient) {
  const realtime = new CentrifugoConversationRealtime(createCentrifugoServerApi());
  return agentMessageReactionRepository(
    db,
    new PrismaDirectConversationRepository(db, {}, realtime),
  );
}

export const Route = createFileRoute("/api/agent/v1/messages_/$messageId/reactions")({
  server: {
    middleware: [agentAuthMiddleware],
    handlers: {
      POST: ({ request, context: { principal, db }, params }) =>
        handleAgentMessageReaction(
          request,
          params.messageId,
          true,
          principal,
          agentReactionRepository(db),
        ),
      DELETE: ({ request, context: { principal, db }, params }) =>
        handleAgentMessageReaction(
          request,
          params.messageId,
          false,
          principal,
          agentReactionRepository(db),
        ),
    },
  },
});
