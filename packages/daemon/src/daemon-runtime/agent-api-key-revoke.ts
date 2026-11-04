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
  scope?: "all",
): Promise<void> {
  if (!agentApiKey) return;
  if (!transport.revokeAgentApiKey) return;
  if (agentApiKeys.get(agentId) === agentApiKey) agentApiKeys.delete(agentId);
  await transport.revokeAgentApiKey(agentApiKey, scope);
}

/**
 * Puts back the key a still-running process holds after a launch that overwrote it failed —
 * but only while the table still holds the failed launch's key, so a concurrent launch's
 * newer key is never clobbered. With no prior key to restore the entry is removed, which is
 * the same outcome the revoke leaves when it runs alone.
 */
export function restoreSupersededAgentApiKey(
  agentApiKeys: Map<string, string>,
  agentId: string,
  supersededKey: string,
  restoredKey: string | undefined,
): void {
  if (agentApiKeys.get(agentId) !== supersededKey) return;
  if (restoredKey === undefined) agentApiKeys.delete(agentId);
  else agentApiKeys.set(agentId, restoredKey);
}
