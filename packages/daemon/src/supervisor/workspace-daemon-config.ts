import type { ManagedBinding } from "./machine-supervisor";

/**
 * The config a Workspace daemon child reads, derived from its binding: pending operations are
 * ready hints; terminal ones are results it owes the server. The Coordinator-only fields
 * (enabled state, restart progress and receipts, legacy dedupe lists) stay out of it.
 */
export function workspaceDaemonConfig(binding: ManagedBinding) {
  // Only the replacement receives the pending request as a cloud ready hint.
  // Local completion still requires the application handshake and durable result.
  const restartRequestIds = (binding.restartResults ?? [])
    .filter((result) => result.status === "completed")
    .map((result) => result.requestId);
  if (binding.restart?.phase === "starting") restartRequestIds.push(binding.restart.requestId);
  const {
    enabled: _enabled,
    restart: _restart,
    restartResults: _results,
    restartRequestIds: _legacy,
    upgradeRequestIds: _upgrades,
    upgradeRequests: _legacyUpgrades,
    upgradeOperations,
    ...config
  } = binding;
  const operations = (upgradeOperations ?? [])
    .filter((operation) => operation.state !== "acknowledged")
    .slice(-128);
  return {
    ...config,
    restartRequestIds: restartRequestIds.slice(-128),
    upgradeRequestIds: operations.map((entry) => entry.requestId),
    upgradeExpectedVersions: Object.fromEntries(
      operations.map((entry) => [entry.requestId, entry.expectedVersion]),
    ),
    upgradeOperations: operations,
  };
}
