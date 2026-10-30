import { createFileRoute } from "@tanstack/react-router";
import { agentAuthMiddleware } from "#src/server/agents/agent-http-middleware.server";
import { handleTaskFollowPost } from "#src/server/tasks/task-conversation-routes.server";
import { taskConversationsGate } from "#src/server/tasks/task-conversations-gate.server";
import { TaskConversations } from "#src/server/tasks/task-conversations.server";

export const Route = createFileRoute("/api/agent/v1/tasks_/follow")({
  server: {
    middleware: [agentAuthMiddleware],
    handlers: {
      POST: ({ request, context: { principal, db } }) =>
        handleTaskFollowPost(
          request,
          principal,
          new TaskConversations({ db, reader: "agent", dependencies: {} }),
          taskConversationsGate(db, principal),
        ),
    },
  },
});
