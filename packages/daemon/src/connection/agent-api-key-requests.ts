import type { AgentLaunchConfig } from "./daemon-connection-client";
import { requestAgentConfig } from "./agent-config-request";
import { parseAgentApiKey, parseAgentLaunchConfig } from "./agent-launch-response";

/** What the Agent API key endpoint's requests need from the connection, read per request. */
export type AgentApiKeyEndpoint = {
  url(what: string): string;
  token(): string;
};

/** One request against the Agent API key endpoint; `what` names the caller in errors. */
function agentApiKeyRequest(
  endpoint: AgentApiKeyEndpoint,
  what: string,
  method: "POST" | "DELETE",
  body: unknown,
) {
  return requestAgentConfig({
    url: () => endpoint.url(what),
    what,
    method,
    token: endpoint.token(),
    body: JSON.stringify(body),
    // Revoking is not retried: one request per key, exactly when its Agent is gone.
    ...(method === "DELETE" ? { retryDelaysMs: [] } : {}),
  });
}

export async function requestAgentApiKey(
  endpoint: AgentApiKeyEndpoint,
  input: { agentId: string; workspaceId: string },
): Promise<string> {
  const value = (await (
    await agentApiKeyRequest(endpoint, "Agent API key", "POST", input)
  ).json()) as {
    apiKey?: unknown;
  };
  return parseAgentApiKey(value.apiKey);
}

export async function requestAgentLaunchConfig(
  endpoint: AgentApiKeyEndpoint,
  input: {
    agentId: string;
    workspaceId: string;
    controlEpoch?: number;
    requestId?: string;
    launchId?: string;
  },
): Promise<AgentLaunchConfig> {
  return parseAgentLaunchConfig(
    await (await agentApiKeyRequest(endpoint, "Agent launch config", "POST", input)).json(),
  );
}

export async function revokeAgentApiKey(
  endpoint: AgentApiKeyEndpoint,
  agentApiKey: string,
  scope?: "all",
): Promise<void> {
  await agentApiKeyRequest(endpoint, "Agent API key revoke", "DELETE", {
    apiKey: agentApiKey,
    ...(scope ? { scope } : {}),
  });
}
