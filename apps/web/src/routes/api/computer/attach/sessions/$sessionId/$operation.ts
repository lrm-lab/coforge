import { createFileRoute } from "@tanstack/react-router";
import { runComputerAttachOperation } from "#src/server/computers/computer-attach-session-http.server";
import { getDatabaseClient } from "#src/server/db/client.server";

export const Route = createFileRoute("/api/computer/attach/sessions/$sessionId/$operation")({
  server: {
    handlers: {
      POST: ({ request, params }) =>
        runComputerAttachOperation(
          getDatabaseClient(),
          params.sessionId,
          params.operation,
          request,
        ),
    },
  },
});
