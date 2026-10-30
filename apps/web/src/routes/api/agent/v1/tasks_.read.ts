import { createFileRoute } from "@tanstack/react-router";
import { agentAuthMiddleware } from "#src/server/agents/agent-http-middleware.server";
import { handleTaskReadGet } from "#src/server/tasks/task-conversation-routes.server";
import { taskConversationsGate } from "#src/server/tasks/task-conversations-gate.server";
import { TaskConversations } from "#src/server/tasks/task-conversations.server";
import { agentTaskPrincipal } from "#src/server/tasks/task-principal.server";

export const Route = createFileRoute("/api/agent/v1/tasks_/read")({
  server: {
    middleware: [agentAuthMiddleware],
    handlers: {
      GET: ({ request, context: { principal, db } }) =>
        handleTaskReadGet(
          request,
          agentTaskPrincipal(principal),
          new TaskConversations({ db, reader: "agent", dependencies: {} }),
          taskConversationsGate(db, principal),
        ),
    },
  },
});
