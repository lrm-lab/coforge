import { createFileRoute } from "@tanstack/react-router";
import { agentAuthMiddleware } from "#src/server/agents/agent-http-middleware.server";
import { handleTaskReplyPost } from "#src/server/tasks/task-conversation-routes.server";
import { TaskConversations } from "#src/server/tasks/task-conversations.server";

export const Route = createFileRoute("/api/agent/v1/tasks_/reply")({
  server: {
    middleware: [agentAuthMiddleware],
    handlers: {
      POST: ({ request, context: { principal, db } }) =>
        handleTaskReplyPost(
          request,
          principal,
          new TaskConversations({ db, reader: "agent", dependencies: {} }),
        ),
    },
  },
});
