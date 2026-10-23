import { createFileRoute } from "@tanstack/react-router";
import { currentAppBotEndpoint } from "#src/server/app-bots/app-bots-composition.server";
import { notFound } from "#src/server/authorization-server/http.server";

// An app's backend mints the bot's key for one installation with its client credentials
// (`server/app-bots/`). Not behind a flag; no issuer configured is 404.
export const Route = createFileRoute("/api/app-installations/$installationId/bot-token")({
  server: {
    handlers: {
      POST: ({ request, params }): Promise<Response> | Response =>
        currentAppBotEndpoint()?.token(request, params.installationId) ?? notFound(),
    },
  },
});
