import { createFileRoute } from "@tanstack/react-router";
import {
  isAgentInboxView,
  type AgentInboxListResponse,
  type AgentInboxRequest,
} from "@lrm/coforge-sdk/agent";
import { agentAuthMiddleware } from "#src/server/agents/agent-http-middleware.server";
import { listAgentInbox } from "#src/server/agents/agent-inbox-list.server";

/**
 * `GET /api/agent/v1/inbox/conversations[?view=unread|mentions][&before_seq=<n>]` — the unread
 * list of `coforge inbox check`. `before_seq` is the `nextBeforeSeq` of the previous page.
 */
export async function handleAgentInboxListGet(
  request: Request,
  list: (options: AgentInboxRequest) => Promise<AgentInboxListResponse>,
): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const view = params.get("view") ?? "unread";
  const rawBefore = params.get("before_seq");
  const beforeSeq = rawBefore === null ? undefined : Number(rawBefore);
  if (!isAgentInboxView(view))
    return Response.json({ error: "view must be unread or mentions" }, { status: 400 });
  if (beforeSeq !== undefined && (!Number.isSafeInteger(beforeSeq) || beforeSeq < 1))
    return Response.json({ error: "before_seq must be a positive integer" }, { status: 400 });
  return Response.json(await list({ view, beforeSeq }));
}

export const Route = createFileRoute("/api/agent/v1/inbox/conversations")({
  server: {
    middleware: [agentAuthMiddleware],
    handlers: {
      GET: ({ request, context: { principal, db } }) =>
        handleAgentInboxListGet(request, (options) =>
          listAgentInbox(db, principal.workspaceId, principal.agentId, options),
        ),
    },
  },
});
