import { createFileRoute } from "@tanstack/react-router";
import type { AgentInboxDismissRequest, AgentInboxDismissResponse } from "@lrm/coforge-sdk/agent";
import { encodeReminderSync } from "@lrm/coforge-sdk/internal";
import { isAppError } from "#src/lib/app-error";
import {
  agentAuthMiddleware,
  agentErrorResponse,
} from "#src/server/agents/agent-http-middleware.server";
import { readAgentJsonBody } from "#src/server/agents/agent-http-routes.server";
import { dismissAgentInbox } from "#src/server/agents/agent-inbox-actions.server";
import {
  createCentrifugoServerApi,
  daemonControlChannel,
} from "#src/server/centrifugo/server-api.server";
import { CentrifugoConversationRealtime } from "#src/server/conversations/conversation-realtime.server";
import { ReminderRefusal, type ReminderPublisher } from "#src/server/reminders/reminders.server";

const ISO_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;

const REMINDER_REFUSAL_STATUS: Record<ReminderRefusal["code"], number> = {
  INVALID_INPUT: 400,
  ACCESS_DENIED: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  TEMPORARILY_UNAVAILABLE: 503,
  RATE_LIMITED: 429,
};

function optionalRealtimePorts(): {
  realtime?: CentrifugoConversationRealtime;
  publishReminderSync?: ReminderPublisher;
} {
  try {
    const centrifugo = createCentrifugoServerApi();
    return {
      realtime: new CentrifugoConversationRealtime(centrifugo),
      publishReminderSync: async (sync) => {
        await centrifugo.publish(
          daemonControlChannel(sync.workspaceId, sync.computerId),
          encodeReminderSync(sync),
        );
      },
    };
  } catch {
    return {};
  }
}

export async function handleAgentInboxDismissPost(
  request: Request,
  dismiss: (input: AgentInboxDismissRequest) => Promise<AgentInboxDismissResponse>,
): Promise<Response> {
  const body = await readAgentJsonBody(request);
  if (!body || typeof body !== "object") {
    return Response.json(
      { error: "JSON object body is required", code: "INVALID_INPUT" },
      { status: 400 },
    );
  }
  const target = typeof body.target === "string" ? body.target.trim() : undefined;
  const before = typeof body.before === "string" ? body.before.trim() : undefined;
  if ((target ? 1 : 0) + (before ? 1 : 0) !== 1) {
    return Response.json(
      {
        error: "specify exactly one of target or before",
        code: "INVALID_INPUT",
      },
      { status: 400 },
    );
  }
  if (before !== undefined) {
    const parsed = ISO_TIMESTAMP.test(before) ? new Date(before) : undefined;
    if (!parsed || Number.isNaN(parsed.getTime())) {
      return Response.json(
        { error: "before must be a valid ISO-8601 timestamp", code: "INVALID_INPUT" },
        { status: 400 },
      );
    }
  }
  try {
    return Response.json(
      await dismiss(target ? { target } : { before: new Date(before!).toISOString() }),
    );
  } catch (error) {
    if (error instanceof ReminderRefusal) {
      return Response.json(
        { error: error.message, code: error.code },
        { status: REMINDER_REFUSAL_STATUS[error.code] ?? 400 },
      );
    }
    if (isAppError(error)) return agentErrorResponse(error);
    throw error;
  }
}

export const Route = createFileRoute("/api/agent/v1/inbox/dismiss")({
  server: {
    middleware: [agentAuthMiddleware],
    handlers: {
      POST: ({ request, context: { principal, db } }) =>
        handleAgentInboxDismissPost(request, (input) =>
          dismissAgentInbox(db, principal, input, optionalRealtimePorts()),
        ),
    },
  },
});
