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

async function refusalOf(response: Response) {
  const body: unknown = await response.json().catch(() => undefined);
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  return {
    message: typeof record.error === "string" ? record.error : `HTTP ${response.status}`,
    code: typeof record.code === "string" ? record.code : undefined,
    retryable: record.retryable === true,
    uploadTo:
      record.details && typeof record.details === "object"
        ? (record.details as Record<string, unknown>).uploadTo
        : undefined,
  };
}

function reuploadAction(uploadTo: unknown) {
  return typeof uploadTo === "string"
    ? `Upload the file again with \`coforge attachment upload --path <file> --target '${uploadTo}'\`, then reply with the new attachment id.`
    : "Upload the file again to this task's conversation, then reply with the new attachment id.";
}

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
    const { message, code, retryable, uploadTo } = await refusalOf(response);
    const failure = (name: string, isRetryable: boolean) =>
      new CliError({
        code: name,
        message,
        retryable: isRetryable,
        ...(name === "ATTACHMENT_IN_OTHER_CONVERSATION"
          ? { suggestedNextAction: reuploadAction(uploadTo) }
          : {}),
      });
    if (response.status >= 500) throw failure("SERVER_5XX", true);
    if (response.status === 404 && !code) throw failure("NOT_FOUND", false);
    throw failure(code ? code.toUpperCase() : operationFailedCode(operation), retryable);
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
