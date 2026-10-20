import {
  authorizationServerConfiguration,
  type AuthorizationServerConfiguration,
} from "./configuration.server";
import { discoveryDocument } from "./discovery.server";
import { publicJwks } from "./signing-keys.server";

const NO_STORE = { "cache-control": "no-store" } as const;
const PUBLIC_METADATA = { "cache-control": "public, max-age=300" } as const;

/** OpenID Connect Discovery 1.0 for the CoForge issuer. */
export function oidcDiscovery(
  configuration: AuthorizationServerConfiguration = authorizationServerConfiguration(),
): Response {
  if (configuration.status === "disabled") return notFound();
  return Response.json(discoveryDocument(configuration.issuer), { headers: PUBLIC_METADATA });
}

/** The issuer's public signing keys (`jwks_uri`). */
export function oidcJwks(
  configuration: AuthorizationServerConfiguration = authorizationServerConfiguration(),
): Response {
  if (configuration.status === "disabled") return notFound();
  return Response.json(publicJwks(configuration.signingKeys), { headers: PUBLIC_METADATA });
}

/** No issuer configured: this deployment runs no authorization server. */
function notFound(): Response {
  return Response.json({ error: "not_found" }, { status: 404, headers: NO_STORE });
}
