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
    const outcome = upgradeOutcome(await onUpgrade(requestId, target));
    if (outcome.state === "failed") {
      setUpgradeRequest({ state: "refused", version, target, ...outcome.failure });
      return;
    }
    followComputerUpgrade(queryClient, { computerId, requestId, startedHere: true });
    setUpgradeRequest({ state: "accepted", requestId, version, target });
  } catch (error) {
    setUpgradeRequest({
      state: "refused",
      version,
      target,
      ...describeUpgradeRequestError(error),
    });
  }
}
