import { createFileRoute } from "@tanstack/react-router";
import { currentAppBotEndpoint } from "#src/server/app-bots/app-bots-composition.server";
import { notFound } from "#src/server/authorization-server/http.server";

// An app's backend publishes the line shown beside its bot, with its client credentials
// (`server/app-bots/`). Not behind a flag; no issuer configured is 404.
export const Route = createFileRoute("/api/app-installations/$installationId/bot-status")({
  server: {
    handlers: {
      PUT: ({ request, params }): Promise<Response> | Response =>
        currentAppBotEndpoint()?.status(request, params.installationId) ?? notFound(),
    },
  },
});
