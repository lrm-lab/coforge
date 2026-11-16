import { errorResponse } from "./agent-http-error.server";
import { externalAgentFeature } from "./external-agent-capabilities.server";
import {
  ExternalCredentialError,
  EXTERNAL_AGENT_KEY_PREFIX,
  authenticateExternalAgentKey,
  type ExternalAgentCredentialRepository,
  type ExternalAgentPrincipal,
} from "./external-agent-credentials.server";

const API_PREFIX = "/api/agent/v1/";

export function unsupportedForExternalAgents(feature: string): Response {
  return Response.json(
    {
      error: "This operation is not available to external Agents",
      code: "unsupported_for_external_agents",
      feature,
      retryable: false,
    },
    { status: 403 },
  );
}

export async function authenticateExternalAgentRequest(
  request: Request,
  repository: Pick<ExternalAgentCredentialRepository, "findByHash" | "touch">,
): Promise<{ principal: ExternalAgentPrincipal } | Response | undefined> {
  if (request.headers.has("x-coforge-agent-api-key")) return undefined;
  const authorization = request.headers.get("authorization");
  const apiKey = authorization?.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  if (!apiKey.startsWith(EXTERNAL_AGENT_KEY_PREFIX)) return undefined;
  let principal: ExternalAgentPrincipal;
  try {
    principal = await authenticateExternalAgentKey(apiKey, repository);
  } catch (error) {
    if (!(error instanceof ExternalCredentialError)) throw error;
    console.warn(JSON.stringify({ event: "external_agent.auth_failed", reason: error.reason }));
    return errorResponse("invalid_credential", "unauthorized", 401, false);
  }
  const { pathname } = new URL(request.url);
  if (!externalAgentFeature(request.method, pathname))
    return unsupportedForExternalAgents(pathname.slice(API_PREFIX.length).replace(/\/+$/, ""));
  return { principal };
}
