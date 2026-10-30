import { createFileRoute } from "@tanstack/react-router";

import { handleSubscriptionProxy } from "#src/server/centrifugo/subscribe-proxy.server";

// A tokenless subscription's grant ran out: Centrifugo asks whether its user still may hold it.
export const Route = createFileRoute("/api/internal/centrifugo-sub-refresh")({
  server: {
    handlers: { POST: ({ request }) => handleSubscriptionProxy(request, true) },
  },
});
