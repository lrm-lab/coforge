import { requestUpgrade } from "./runtime-lifecycle-operations";
import type { UpgradeResultReporter } from "./upgrade-result-reporter";

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
