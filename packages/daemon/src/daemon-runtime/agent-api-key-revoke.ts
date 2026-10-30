import type { DaemonConnectionClient } from "#src/connection/daemon-connection-client";

/**
 * Revokes the key of an Agent process that is gone: it exited, its Stop was requested, or its
 * launch failed after the key was minted. One request, exactly then, and never again:
 * a key still in use by a running Agent is never revoked by the daemon, and
 * a revoke that fails is logged and left to the server, which invalidates every earlier key
 * of the Agent when it mints the next one.
 */
export async function revokeAgentApiKey(
  transport: DaemonConnectionClient,
  agentApiKeys: Map<string, string>,
  agentId: string,
  agentApiKey: string | undefined,
): Promise<void> {
  if (!agentApiKey) return;
  if (!transport.revokeAgentApiKey) return;
  if (agentApiKeys.get(agentId) === agentApiKey) agentApiKeys.delete(agentId);
  await transport.revokeAgentApiKey(agentApiKey);
}
