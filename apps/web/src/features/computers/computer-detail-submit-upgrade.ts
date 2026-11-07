import type { QueryClient } from "@tanstack/react-query";
import { describeUpgradeRequestError, upgradeOutcome } from "./upgrade-failure";
import { followComputerUpgrade } from "./computer-upgrade-status";
import type { ComputerUpgradeRequest } from "./computer-upgrade-slot";
import type { ComputerUpgradeStatus } from "./computer.schemas";

export async function submitComputerDetailUpgrade(input: {
  computerId: string;
  onUpgrade?: (requestId: string, target?: "runtime" | "image") => Promise<ComputerUpgradeStatus>;
  queryClient: QueryClient;
  setUpgradeRequest: (request: ComputerUpgradeRequest) => void;
  version: string | undefined;
  target: "runtime" | "image";
}): Promise<void> {
  const { onUpgrade, queryClient, setUpgradeRequest, version, target, computerId } = input;
  if (!onUpgrade) return;
  const requestId = crypto.randomUUID();
  setUpgradeRequest({ state: "requesting", version, target });
  try {
    const status = await onUpgrade(requestId, target);
    const outcome = upgradeOutcome(status);
    if (outcome.state === "failed") {
      setUpgradeRequest({ state: "refused", version, target, ...outcome.failure });
      return;
    }
    // The server answers with the upgrade it actually holds: a request that lost the race to
    // one already in flight comes back under that request's id and row, so follow those.
    const acceptedVersion = "expectedVersion" in status ? status.expectedVersion : version;
    const acceptedTarget = "target" in status ? (status.target ?? target) : target;
    followComputerUpgrade(queryClient, {
      computerId,
      requestId: status.requestId,
      startedHere: true,
    });
    setUpgradeRequest({
      state: "accepted",
      requestId: status.requestId,
      version: acceptedVersion,
      target: acceptedTarget,
    });
  } catch (error) {
    setUpgradeRequest({
      state: "refused",
      version,
      target,
      ...describeUpgradeRequestError(error),
    });
  }
}
