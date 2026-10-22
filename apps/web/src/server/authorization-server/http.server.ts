import {
  authorizationServerConfiguration,
  type AuthorizationServerConfiguration,
} from "./configuration.server";
import { discoveryDocument } from "./discovery.server";
import { NO_STORE } from "./http-headers.server";
import { publicJwks } from "./signing-keys.server";
import { currentTokenEndpoints } from "./token-endpoint-composition.server";

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

/** The token endpoint (`TOKEN_ENDPOINT_PATH`). */
export async function oidcToken(request: Request): Promise<Response> {
  const endpoints = currentTokenEndpoints();
  return endpoints ? endpoints.token.exchange(request) : notFound();
}

/** The UserInfo endpoint (`USERINFO_ENDPOINT_PATH`), for GET and POST alike. */
export async function oidcUserInfo(request: Request): Promise<Response> {
  const endpoints = currentTokenEndpoints();
  return endpoints ? endpoints.userInfo.answer(request) : notFound();
}

/** The installation setup API (`GET`, `PUT /api/app-installations/<id>/setup`). */
export async function appInstallationSetup(
  request: Request,
  installationId: string,
): Promise<Response> {
  const endpoints = currentTokenEndpoints();
  return endpoints ? endpoints.setup.answer(request, installationId) : notFound();
}

/** An app's lookup of its installation in a Workspace (`POST /api/app-installations/lookup`). */
export async function appInstallationLookup(request: Request): Promise<Response> {
  const endpoints = currentTokenEndpoints();
  return endpoints ? endpoints.setup.lookup(request) : notFound();
}

/** No issuer configured: this deployment runs no authorization server. */
function notFound(): Response {
  return Response.json({ error: "not_found" }, { status: 404, headers: NO_STORE });
}
