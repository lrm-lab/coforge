import type { AgentTaskConversationRequest } from "@lrm/coforge-sdk/agent";
import { agentApiRoutes } from "@lrm/coforge-sdk/agent";
import { CliError } from "./cli-error";
import { operationFailedCode, requireProxySetup } from "./proxy-request";

const OPERATION: Record<AgentTaskConversationRequest["route"], string> = {
  view: "view",
  read: "read",
  reply: "reply",
  follow: "follow",
  unfollow: "follow",
  following: "list",
};

/** The server's own words for a refusal: its `{ error, code? }` body, or just the status. */
async function refusalOf(response: Response) {
  const body: unknown = await response.json().catch(() => undefined);
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  return {
    message: typeof record.error === "string" ? record.error : `HTTP ${response.status}`,
    code: typeof record.code === "string" ? record.code : undefined,
  };
}

/**
 * One task conversation route through the local Proxy, answered as the server's JSON. The Proxy
 * forwards the server's own status and `{ error, code? }` body: a 404 is `NOT_FOUND`, a 5xx
 * `SERVER_5XX`, and any other refusal keeps the server's code or is `<COMMAND>_FAILED`. A 5xx or a
 * transport failure is retryable: a reply carries one key throughout, so repeating it cannot post
 * twice.
 */
export async function taskConversationRequest(
  proxyEndpoint: (path: string) => URL,
  context: string,
  proxyUrl: string,
  request: AgentTaskConversationRequest,
): Promise<unknown> {
  const operation = OPERATION[request.route];
  requireProxySetup(operation, context, proxyUrl);
  const route = agentApiRoutes.local.taskConversations[request.route];
  const endpoint = proxyEndpoint(route.path);
  for (const [name, value] of Object.entries(request.query ?? {}))
    endpoint.searchParams.set(name, value);
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: route.method,
      headers: {
        authorization: `Bearer ${context}`,
        ...(request.body ? { "content-type": "application/json" } : {}),
      },
      ...(request.body ? { body: JSON.stringify(request.body) } : {}),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new CliError({
      code: operationFailedCode(operation),
      message: "agent proxy request failed (network or timeout)",
      retryable: true,
    });
  }
  if (!response.ok) {
    const { message, code } = await refusalOf(response);
    const failure = (name: string, retryable: boolean) =>
      new CliError({ code: name, message, retryable });
    if (response.status >= 500) throw failure("SERVER_5XX", true);
    if (response.status === 404 && !code) throw failure("NOT_FOUND", false);
    throw failure(code ? code.toUpperCase() : operationFailedCode(operation), false);
  }
  try {
    return await response.json();
  } catch {
    throw new CliError({
      code: "INVALID_JSON_RESPONSE",
      message: "the task response was not JSON",
      retryable: false,
    });
  }
}
