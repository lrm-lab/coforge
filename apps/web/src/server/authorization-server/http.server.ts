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

/** An app asks to send to an Agent (`POST /api/app-agent-requests`). */
export async function appAgentRequest(request: Request): Promise<Response> {
  const endpoints = currentTokenEndpoints();
  return endpoints ? endpoints.agentInbound.request(request) : notFound();
}

/** An app reads its own Agent request (`GET /api/app-agent-requests/<id>`). */
export async function appAgentRequestStatus(
  request: Request,
  requestId: string,
): Promise<Response> {
  const endpoints = currentTokenEndpoints();
  return endpoints ? endpoints.agentInbound.status(request, requestId) : notFound();
}

/** An app posts an event or a notification to its Agent (`POST /api/app-agent-events`). */
export async function appAgentEvent(request: Request): Promise<Response> {
  const endpoints = currentTokenEndpoints();
  return endpoints ? endpoints.agentInbound.post(request) : notFound();
}

/** No issuer configured: this deployment runs no authorization server. */
export function notFound(): Response {
  return Response.json({ error: "not_found" }, { status: 404, headers: NO_STORE });
}
