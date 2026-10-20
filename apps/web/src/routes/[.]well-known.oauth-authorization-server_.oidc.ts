import { createFileRoute } from "@tanstack/react-router";
import { oidcDiscovery } from "#src/server/authorization-server/http.server";

// RFC 8414 §3.1 metadata for the issuer `<origin>/oidc`: the same document as its OpenID
// configuration. The `_` keeps this route a sibling of the device flow's discovery, not its child.
export const Route = createFileRoute("/.well-known/oauth-authorization-server_/oidc")({
  server: { handlers: { GET: (): Response => oidcDiscovery() } },
});
