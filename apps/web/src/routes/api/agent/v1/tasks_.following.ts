import { createFileRoute } from "@tanstack/react-router";
import { agentAuthMiddleware } from "#src/server/agents/agent-http-middleware.server";
import { handleTaskFollowingGet } from "#src/server/tasks/task-conversation-routes.server";
import { TaskConversations } from "#src/server/tasks/task-conversations.server";

export const Route = createFileRoute("/api/agent/v1/tasks_/following")({
  server: {
    middleware: [agentAuthMiddleware],
    handlers: {
      GET: ({ context: { principal, db } }) =>
        handleTaskFollowingGet(
          principal,
          new TaskConversations({ db, reader: "agent", dependencies: {} }),
        ),
    },
  },
});
