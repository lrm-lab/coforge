import { selectsCodexCompatible } from "@lrm/coforge-sdk/internal/codex-compatible-provider";
import type { AgentRuntimeConfig } from "@coforge/agent";
import type { AgentLaunchConfig } from "#src/connection/daemon-connection-client";
import type { DaemonConnectionClient } from "#src/connection/daemon-connection-client";
export async function requestAgentLaunchConfig(
  transport: DaemonConnectionClient,
  workspaceId: string,
  agentId: string,
  managedScope: { controlEpoch?: number; requestId: string; launchId: string } | undefined,
  selection?: Pick<AgentRuntimeConfig, "provider" | "modelProvider">,
): Promise<AgentLaunchConfig> {
  const config = await readLaunchConfig(transport, workspaceId, agentId, managedScope);
  if (
    selection &&
    selectsCodexCompatible(selection.provider, selection.modelProvider) !==
      Boolean(config.codexCompatibleEnvironment)
  )
    throw new Error(
      "Codex compatible provider launch configuration disagrees with the saved runtime",
    );
  return config;
}

async function readLaunchConfig(
  transport: DaemonConnectionClient,
  workspaceId: string,
  agentId: string,
  managedScope: { controlEpoch?: number; requestId: string; launchId: string } | undefined,
): Promise<AgentLaunchConfig> {
  if (transport.requestAgentLaunchConfig)
    return transport.requestAgentLaunchConfig({
      agentId,
      workspaceId,
      ...(managedScope ? managedScope : {}),
    });
  if (transport.requestAgentApiKey)
    return { agentApiKey: await transport.requestAgentApiKey({ agentId, workspaceId }) };
  throw new Error("Agent API key endpoint is not configured");
}
