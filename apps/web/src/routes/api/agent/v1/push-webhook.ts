import { createFileRoute } from "@tanstack/react-router";
import { agentAuthMiddleware } from "#src/server/agents/agent-http-middleware.server";
import { handlePushWebhook } from "#src/server/agents/external-push-webhook-http.server";
import { createExternalPushWebhooks } from "#src/server/agents/external-push-webhooks-composition.server";

const respond = ({
  request,
  context: { principal },
}: {
  request: Request;
  context: { principal: { workspaceId: string; agentId: string } };
}) => handlePushWebhook(request, principal, createExternalPushWebhooks());

export const Route = createFileRoute("/api/agent/v1/push-webhook")({
  server: {
    middleware: [agentAuthMiddleware],
    handlers: { GET: respond, PUT: respond, DELETE: respond },
  },
});
