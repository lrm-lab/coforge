import { createFileRoute } from "@tanstack/react-router";
import type { AgentInboxReadRequest, AgentInboxReadResponse } from "@lrm/coforge-sdk/agent";
import { isAppError } from "#src/lib/app-error";
import {
  agentAuthMiddleware,
  agentErrorResponse,
} from "#src/server/agents/agent-http-middleware.server";
import { readAgentInboxTarget } from "#src/server/agents/agent-inbox-actions.server";
import { createCentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import { AgentMessageValidationError } from "#src/server/conversations/agent-message-validation-error.server";
import { CentrifugoConversationRealtime } from "#src/server/conversations/conversation-realtime.server";

function optionalRealtime(): CentrifugoConversationRealtime | undefined {
  try {
    return new CentrifugoConversationRealtime(createCentrifugoServerApi());
  } catch {
    return undefined;
  }
}

export async function handleAgentInboxReadGet(
  request: Request,
  read: (input: AgentInboxReadRequest) => Promise<AgentInboxReadResponse>,
): Promise<Response> {
  const query = Object.fromEntries(new URL(request.url).searchParams);
  const target = query.target?.trim() ?? "";
  if (!target) {
    return Response.json({ error: "target is required", code: "INVALID_INPUT" }, { status: 400 });
  }
  const limit = query.limit === undefined ? undefined : Number(query.limit);
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)) {
    return Response.json(
      { error: "limit must be an integer between 1 and 100", code: "INVALID_INPUT" },
      { status: 400 },
    );
  }
  const cursor = query.cursor?.trim() || undefined;
  try {
    return Response.json(
      await read({
        target,
        ...(limit === undefined ? {} : { limit }),
        ...(cursor === undefined ? {} : { cursor }),
      }),
    );
  } catch (error) {
    if (error instanceof AgentMessageValidationError) {
      return Response.json({ error: error.message, code: "INVALID_INPUT" }, { status: 400 });
    }
    if (isAppError(error)) return agentErrorResponse(error);
    throw error;
  }
}

export const Route = createFileRoute("/api/agent/v1/inbox/read")({
  server: {
    middleware: [agentAuthMiddleware],
    handlers: {
      GET: ({ request, context: { principal, db } }) =>
        handleAgentInboxReadGet(request, (input) =>
          readAgentInboxTarget(db, principal, input, { realtime: optionalRealtime() }),
        ),
    },
  },
});
