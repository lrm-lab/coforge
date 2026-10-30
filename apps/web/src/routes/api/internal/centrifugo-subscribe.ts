import { createFileRoute } from "@tanstack/react-router";

import { handleSubscriptionProxy } from "#src/server/centrifugo/subscribe-proxy.server";

// A browser page subscribing to a channel without a token: Centrifugo asks whether its user may hold it.
export const Route = createFileRoute("/api/internal/centrifugo-subscribe")({
  server: {
    handlers: { POST: ({ request }) => handleSubscriptionProxy(request, false) },
  },
});
