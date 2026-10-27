import { createFileRoute } from "@tanstack/react-router";
import type { AgentEventsResponse } from "@lrm/coforge-sdk/agent";
import { handleAppBotEventsGet } from "#src/server/app-bots/app-bot-agent-api.server";
import { agentAuthMiddleware } from "#src/server/agents/agent-http-middleware.server";
import { agentIdempotencyKeyFromQuery } from "#src/server/agents/agent-http-routes.server";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";
import type { PrismaClient } from "#src/generated/prisma/client";
import { createCentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import { CentrifugoConversationRealtime } from "#src/server/conversations/conversation-realtime.server";
import type { ConversationRealtime } from "#src/server/conversations/conversation-realtime.server";
import {
  drainAgentEvents,
  type AgentMessageRepository,
} from "#src/server/agents/agent-messages.server";

export type AgentEventsGetPrincipal = { workspaceId: string; agentId: string };

export function createAgentEventsRepository(db: PrismaClient, realtime?: ConversationRealtime) {
  return new PrismaDirectConversationRepository(
    db,
    {},
    realtime ?? new CentrifugoConversationRealtime(createCentrifugoServerApi()),
  );
}

export function handleAgentEventsRouteGet(
  request: Request,
  principal: AgentEventsGetPrincipal,
  db: PrismaClient,
  createRepository: (db: PrismaClient) => AgentMessageRepository = createAgentEventsRepository,
) {
  return handleAgentEventsGet(request, principal, createRepository(db));
}

export async function handleAgentEventsGet(
  request: Request,
  principal: AgentEventsGetPrincipal,
  repository: AgentMessageRepository,
): Promise<Response> {
  const query = new URL(request.url).searchParams;
  const idempotencyKey = agentIdempotencyKeyFromQuery(request);
  const scope = { workspaceId: principal.workspaceId, agentId: principal.agentId };
  try {
    const limit = query.has("limit") ? Number(query.get("limit")) : undefined;
    if (limit !== undefined && !Number.isInteger(limit)) throw new Error("invalid events limit");
    const target = query.get("target") || undefined;
    const result = await drainAgentEvents(repository, scope, limit, target);
    const response: AgentEventsResponse = {
      idempotencyKey,
      events: result.messages,
      hasMore: result.hasMore,
    };
    return Response.json(response);
  } catch {
    return Response.json({ error: "invalid events query" }, { status: 400 });
  }
}

export const Route = createFileRoute("/api/agent/v1/events")({
  server: {
    middleware: [agentAuthMiddleware],
    handlers: {
      GET: ({ request, context: { principal, db } }) =>
        // An app's bot reads its inbox without taking it (`AppBotInbox`).
        "appBot" in principal
          ? handleAppBotEventsGet(request, principal, db)
          : handleAgentEventsRouteGet(request, principal, db),
    },
  },
});
