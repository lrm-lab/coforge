import { createFileRoute } from "@tanstack/react-router";
import { oidcDiscovery } from "#src/server/authorization-server/http.server";

export const Route = createFileRoute("/oidc/.well-known/openid-configuration")({
  server: { handlers: { GET: (): Response => oidcDiscovery() } },
});
