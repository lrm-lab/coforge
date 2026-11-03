import { createFileRoute } from "@tanstack/react-router";
import { agentAuthMiddleware } from "#src/server/agents/agent-http-middleware.server";
import { handleTaskIdleNudgePost } from "#src/server/tasks/task-conversation-routes.server";
import { idleNudge } from "#src/server/tasks/task-idle-reminder.server";
import { agentTaskPrincipal } from "#src/server/tasks/task-principal.server";

export const Route = createFileRoute("/api/agent/v1/tasks_/idle-nudge")({
  server: {
    middleware: [agentAuthMiddleware],
    handlers: {
      POST: ({ request, context: { principal, db } }) => {
        const agent = agentTaskPrincipal(principal);
        return handleTaskIdleNudgePost(request, (input) => idleNudge(db, agent, input));
      },
    },
  },
});
