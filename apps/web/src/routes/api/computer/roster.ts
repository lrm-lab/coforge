import { createFileRoute } from "@tanstack/react-router";
import { COMPUTER_LIST_METHOD } from "@lrm/coforge-sdk/internal";
import { createComputerHttpHandler } from "#src/server/computers/computer-http.server";

const handler = createComputerHttpHandler();

export const Route = createFileRoute("/api/computer/roster")({
  server: {
    handlers: {
      POST: ({ request }) => handler.handleRequest(request, COMPUTER_LIST_METHOD),
    },
  },
});
