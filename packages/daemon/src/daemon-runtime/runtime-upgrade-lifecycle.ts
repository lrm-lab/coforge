import { requestUpgrade } from "./runtime-lifecycle-operations";
import type { RuntimeStartupPorts } from "./runtime-startup";
import type { UpgradeResultReporter } from "./upgrade-result-reporter";

type StartupLifecycle = RuntimeStartupPorts["lifecycle"];

type UpgradeLifecycle = {
  requestUpgrade?: (
    requestId: string,
    expectedVersion?: string,
    releaseChannel?: string,
  ) => Promise<void>;
};

export function upgradeLifecycleRequest(
  lifecycle: UpgradeLifecycle,
  results: UpgradeResultReporter,
  workspaceId: string,
) {
  if (!lifecycle.requestUpgrade) return undefined;
  return (requestId: string, expectedVersion?: string, releaseChannel?: string) =>
    requestUpgrade(
      lifecycle.requestUpgrade,
      results,
      requestId,
      expectedVersion,
      releaseChannel,
      workspaceId,
    );
}

/** The lifecycle callbacks the startup sequence reads, with the upgrade request reporting its result. */
export function startupLifecycle(
  lifecycle: StartupLifecycle,
  results: UpgradeResultReporter,
  workspaceId: string,
): StartupLifecycle {
  return {
    requestRestart: lifecycle.requestRestart,
    requestUpgrade: upgradeLifecycleRequest(lifecycle, results, workspaceId),
    connectionRefused: lifecycle.connectionRefused,
    recoveredRestartRequestIds: lifecycle.recoveredRestartRequestIds,
    recoveredUpgradeRequestIds: lifecycle.recoveredUpgradeRequestIds,
  };
}
