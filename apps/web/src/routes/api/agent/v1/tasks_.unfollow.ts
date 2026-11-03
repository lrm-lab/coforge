import { createFileRoute } from "@tanstack/react-router";
import { createCentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import { agentAuthMiddleware } from "#src/server/agents/agent-http-middleware.server";
import { handleTaskUnfollowPost } from "#src/server/tasks/task-conversation-routes.server";
import { taskConversationsGate } from "#src/server/tasks/task-conversations-gate.server";
import { agentTaskConversations } from "#src/server/tasks/task-conversations.server";
import { agentTaskPrincipal } from "#src/server/tasks/task-principal.server";

export const Route = createFileRoute("/api/agent/v1/tasks_/unfollow")({
  server: {
    middleware: [agentAuthMiddleware],
    handlers: {
      POST: ({ request, context: { principal, db } }) =>
        handleTaskUnfollowPost(
          request,
          agentTaskPrincipal(principal),
          agentTaskConversations(db, createCentrifugoServerApi()),
          taskConversationsGate(db, principal),
        ),
    },
  },
});
