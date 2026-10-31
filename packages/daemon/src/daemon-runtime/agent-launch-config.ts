import type { AgentLaunchConfig } from "#src/connection/daemon-connection-client";
import type { DaemonConnectionClient } from "#src/connection/daemon-connection-client";
export { wakeReusedAgent } from "./agent-wake-control";
export async function requestAgentLaunchConfig(
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
