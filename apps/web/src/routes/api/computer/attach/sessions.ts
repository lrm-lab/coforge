import { createFileRoute } from "@tanstack/react-router";
import {
  computerAttachCapabilities,
  openComputerAttachSession,
} from "#src/server/computers/computer-attach-session-http.server";

export const Route = createFileRoute("/api/computer/attach/sessions")({
  server: {
    handlers: {
      GET: () => computerAttachCapabilities(),
      POST: ({ request }) => openComputerAttachSession(request),
    },
  },
});
