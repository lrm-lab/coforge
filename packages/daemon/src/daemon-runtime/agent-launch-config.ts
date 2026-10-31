import type { AgentLaunchConfig } from "#src/connection/daemon-connection-client";
import type { DaemonConnectionClient } from "#src/connection/daemon-connection-client";
import type { AgentSession } from "@lrm/coforge-anvil";
import type { SessionIdentity } from "@lrm/coforge-sdk/internal";

/** Reads a reused launch's identity without making wake depend on provider availability. */
export function readSessionIdentityOrUndefined(
  session: Pick<AgentSession, "readSessionIdentity">,
): Promise<SessionIdentity | undefined> {
  return Promise.resolve()
    .then(() => session.readSessionIdentity?.())
    .catch(() => undefined);
}

export function wakeReusedAgent(
  session: Pick<AgentSession, "readSessionIdentity">,
  wake: (identity?: SessionIdentity) => Promise<void>,
): void {
  void readSessionIdentityOrUndefined(session)
    .then(wake)
    .catch(() => {});
}

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
