import { createFileRoute } from "@tanstack/react-router";
import { authingWebhookHandler } from "#src/server/auth/authing-webhook.server";

export const Route = createFileRoute("/api/authing/webhook")({
  server: { handlers: { POST: authingWebhookHandler } },
});
