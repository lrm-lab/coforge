import { createFileRoute } from "@tanstack/react-router";
import type { AgentThreadAttentionResponse } from "@lrm/coforge-sdk/agent";
import { agentAuthMiddleware } from "#src/server/agents/agent-http-middleware.server";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";
import {
  followAgentThread,
  type AgentMessageRepository,
} from "#src/server/agents/agent-messages.server";
import {
  agentIdempotencyKey,
  agentRouteErrorResponse,
  readAgentJsonBody,
} from "#src/server/agents/agent-http-routes.server";

export type AgentThreadFollowPrincipal = { workspaceId: string; agentId: string };

export async function handleAgentThreadFollowPost(
  request: Request,
  thread: string,
  principal: AgentThreadFollowPrincipal,
  repository: AgentMessageRepository,
): Promise<Response> {
  const scope = { workspaceId: principal.workspaceId, agentId: principal.agentId };
  try {
    const body = await readAgentJsonBody(request);
    const idempotencyKey = agentIdempotencyKey(body);
    await followAgentThread(repository, scope, thread);
    const response: AgentThreadAttentionResponse = {
      idempotencyKey,
      target: thread,
      followed: true,
    };
    return Response.json(response);
  } catch (error) {
    return agentRouteErrorResponse(error, "thread follow failed", [
      "follow requires a channel thread target",
    ]);
  }
}

export const Route = createFileRoute("/api/agent/v1/threads_/$thread/follow")({
  server: {
    middleware: [agentAuthMiddleware],
    handlers: {
      POST: ({ request, context: { principal, db }, params }) =>
        handleAgentThreadFollowPost(
          request,
          params.thread,
          principal,
          new PrismaDirectConversationRepository(db),
        ),
    },
  },
});
