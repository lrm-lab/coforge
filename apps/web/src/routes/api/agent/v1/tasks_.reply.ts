import { createFileRoute } from "@tanstack/react-router";
import { createCentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import { agentAuthMiddleware } from "#src/server/agents/agent-http-middleware.server";
import { getMessageRequestIdempotency } from "#src/server/conversations/redis-message-request-idempotency.server";
import { handleTaskReplyPost } from "#src/server/tasks/task-conversation-routes.server";
import { taskConversationsGate } from "#src/server/tasks/task-conversations-gate.server";
import { TaskConversations } from "#src/server/tasks/task-conversations.server";
import { agentTaskPrincipal } from "#src/server/tasks/task-principal.server";

export const Route = createFileRoute("/api/agent/v1/tasks_/reply")({
  server: {
    middleware: [agentAuthMiddleware],
    handlers: {
      POST: ({ request, context: { principal, db } }) =>
        handleTaskReplyPost(
          request,
          agentTaskPrincipal(principal),
          new TaskConversations(
            { db, reader: "agent", dependencies: { publisher: createCentrifugoServerApi() } },
            getMessageRequestIdempotency(),
          ),
          taskConversationsGate(db, principal),
        ),
    },
  },
});
