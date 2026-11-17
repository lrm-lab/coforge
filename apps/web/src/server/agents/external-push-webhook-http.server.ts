import { errorResponse } from "./agent-http-error.server";
import { isExternalAgentPrincipal } from "./external-agent-credentials.server";
import { externalAgentsOnly } from "./external-agent-http.server";
import { PushWebhookRefusal, type ExternalPushWebhooks } from "./external-push-webhooks.server";

type Principal = { workspaceId: string; agentId: string };

export async function handlePushWebhook(
  request: Request,
  principal: Principal,
  webhooks: Pick<ExternalPushWebhooks, "put" | "get" | "remove">,
): Promise<Response> {
  if (!isExternalAgentPrincipal(principal)) return externalAgentsOnly();
  try {
    if (request.method === "PUT") {
      const body: unknown = await request.json().catch(() => undefined);
      return Response.json(await webhooks.put(principal, body));
    }
    if (request.method === "DELETE") {
      await webhooks.remove(principal.agentId);
      return Response.json({ removed: true });
    }
    const view = await webhooks.get(principal.agentId);
    if (!view)
      return errorResponse("push_webhook_not_found", "no push webhook is registered", 404, false);
    return Response.json(view);
  } catch (error) {
    if (error instanceof PushWebhookRefusal)
      return errorResponse(error.code, error.message, error.status, error.status === 503);
    throw error;
  }
}
