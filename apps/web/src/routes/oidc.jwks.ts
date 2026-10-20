import { createFileRoute } from "@tanstack/react-router";
import { oidcJwks } from "#src/server/authorization-server/http.server";

export const Route = createFileRoute("/oidc/jwks")({
  server: { handlers: { GET: (): Response => oidcJwks() } },
});
