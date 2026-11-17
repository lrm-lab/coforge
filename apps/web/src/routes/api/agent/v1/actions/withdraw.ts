import { createFileRoute } from "@tanstack/react-router";
import type { AgentActionWithdrawResponse } from "@lrm/coforge-sdk/agent";
import { isAppError } from "#src/lib/app-error";
import {
  agentAuthMiddleware,
  agentErrorResponse,
} from "#src/server/agents/agent-http-middleware.server";
import { readAgentJsonBody } from "#src/server/agents/agent-http-routes.server";
import { createCentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import { withdrawActionCard } from "#src/server/conversations/action-card-withdraw.server";
import { CentrifugoConversationRealtime } from "#src/server/conversations/conversation-realtime.server";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type AgentActionWithdrawPrincipal = { workspaceId: string; agentId: string };

export async function handleAgentActionWithdraw(
  request: Request,
  principal: AgentActionWithdrawPrincipal,
  withdraw: (
    principal: AgentActionWithdrawPrincipal,
    messageId: string,
  ) => Promise<AgentActionWithdrawResponse>,
): Promise<Response> {
  const body = await readAgentJsonBody(request);
  const messageId =
    body && typeof body === "object" && typeof body.messageId === "string"
      ? body.messageId.trim()
      : "";
  if (!UUID.test(messageId)) {
    return Response.json(
      { error: "messageId must be a valid UUID", code: "INVALID_INPUT" },
      { status: 400 },
    );
  }
  try {
    return Response.json(await withdraw(principal, messageId));
  } catch (error) {
    if (isAppError(error)) return agentErrorResponse(error);
    throw error;
  }
}

export const Route = createFileRoute("/api/agent/v1/actions/withdraw")({
  server: {
    middleware: [agentAuthMiddleware],
    handlers: {
      POST: ({ request, context: { principal, db } }) =>
        handleAgentActionWithdraw(request, principal, (scope, messageId) =>
          withdrawActionCard(
            db,
            new CentrifugoConversationRealtime(createCentrifugoServerApi()),
            scope,
            messageId,
          ),
        ),
    },
  },
});
