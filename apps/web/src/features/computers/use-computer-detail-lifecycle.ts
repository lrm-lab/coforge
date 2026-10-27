import { useEffect, useRef, useState } from "react";
import { useQueries, useQueryClient } from "@tanstack/react-query";

import { useAppToast } from "#src/components/ui/toast";
import { m } from "#src/paraglide/messages";
import { computerDetailUpgradeSlotsFor } from "./computer-detail-upgrade-slots";
import { submitComputerDetailUpgrade } from "./computer-detail-submit-upgrade";
import { computerUpgradeStatusQuery, upgradeRunning } from "./computer-upgrade-status";
import type { ComputerUpgradeRequest } from "./computer-upgrade-slot";
import type { ComputerRestartStatus, ComputerUpgradeStatus } from "./computer.schemas";
import {
  describeUpgradeRequestError,
  upgradeOutcome,
  type ComputerUpgradeOutcome,
} from "./upgrade-failure";

/** Upgrade slots and restart polling for one Computer detail panel. */
export function useComputerDetailLifecycle(input: {
  computerId: string;
  kind: string;
  computerVersion?: string | null;
  imageVersion?: string | null;
  imageUpdate?: { version: string } | null;
  upgrade?: ComputerUpgradeStatus | null;
  latestComputerVersion?: string | null;
  onUpgrade?: (requestId: string, target?: "runtime" | "image") => Promise<ComputerUpgradeStatus>;
  onRestart?: (requestId: string) => Promise<ComputerRestartStatus>;
  onReadRestartStatus?: (requestId: string) => Promise<ComputerRestartStatus>;
  restartPollIntervalMs: number;
  restartMaxPolls: number;
}) {
  const toast = useAppToast();
  const queryClient = useQueryClient();
  const mountedRef = useRef(true);
  useEffect(() => {
    // Set again on mount: StrictMode unmounts and remounts once in development.
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const [restartState, setRestartState] = useState<
    "idle" | "pending" | "accepted" | "completed" | "error"
  >("idle");
  const [upgradeRequest, setUpgradeRequest] = useState<ComputerUpgradeRequest>({ state: "idle" });
  const storedUpgrade = input.upgrade ?? undefined;
  const followedUpgradeId =
    upgradeRequest.state === "accepted"
      ? upgradeRequest.requestId
      : storedUpgrade && upgradeRunning(storedUpgrade)
        ? storedUpgrade.requestId
        : null;
  const [liveStatus] = useQueries({
    queries: (followedUpgradeId ? [followedUpgradeId] : []).map((requestId) => ({
      ...computerUpgradeStatusQuery(input.computerId, requestId),
      enabled: false,
    })),
  });
  const storedOutcome = storedUpgrade ? upgradeOutcome(storedUpgrade) : undefined;
  // A recovery fetch keeps the last error until it returns. The status it already holds is
  // what the slot shows while that read is in flight.
  const liveUpgrade: ComputerUpgradeOutcome | undefined = !liveStatus
    ? undefined
    : liveStatus.isError && !liveStatus.isFetching
      ? { state: "failed", failure: describeUpgradeRequestError(liveStatus.error) }
      : liveStatus.data
        ? upgradeOutcome(liveStatus.data)
        : upgradeRequest.state === "accepted"
          ? { state: "running" }
          : (storedOutcome ?? { state: "running" });
  // A stored success is history: the loader's version already includes it.
  const upgrade: ComputerUpgradeOutcome | { state: "idle" } =
    upgradeRequest.state === "requesting"
      ? { state: "running" }
      : upgradeRequest.state === "refused"
        ? { state: "failed", failure: upgradeRequest }
        : (liveUpgrade ??
          (storedOutcome && storedOutcome.state !== "succeeded"
            ? storedOutcome
            : { state: "idle" }));
  const slots = computerDetailUpgradeSlotsFor(
    {
      kind: input.kind,
      computerVersion: input.computerVersion,
      imageVersion: input.imageVersion,
      imageUpdate: input.imageUpdate,
    },
    {
      upgrade,
      request: upgradeRequest,
      liveStatus: liveStatus?.data,
      storedUpgrade,
      latestComputerVersion: input.latestComputerVersion,
    },
  );
  const runUpgrade = (version: string | undefined, target: "runtime" | "image") =>
    submitComputerDetailUpgrade({
      computerId: input.computerId,
      onUpgrade: input.onUpgrade,
      queryClient,
      setUpgradeRequest,
      version,
      target,
    });
  const runRestart = () => {
    if (!input.onRestart) return;
    setRestartState("pending");
    const requestId = crypto.randomUUID();
    // The restart poll outlives navigation; only touch state while still mounted.
    const settle = (update: () => void) => {
      if (mountedRef.current) update();
    };
    void input
      .onRestart(requestId)
      .then(async (initial) => {
        if (initial.status !== "accepted") return initial;
        settle(() => {
          setRestartState("accepted");
          toast.success(m.computer_restart_accepted());
        });
        if (!input.onReadRestartStatus) return initial;
        for (let poll = 0; poll < input.restartMaxPolls; poll += 1) {
          await new Promise((resolve) => window.setTimeout(resolve, input.restartPollIntervalMs));
          const result = await input.onReadRestartStatus(requestId);
          if (result.status !== "accepted") return result;
        }
        return { requestId, status: "failed" as const, reason: "timeout" as const };
      })
      .then(
        (result) =>
          settle(() => {
            if (result.status === "completed") {
              setRestartState("completed");
              toast.success(m.computer_restart_completed());
            } else if (result.status === "accepted") {
              setRestartState("accepted");
            } else {
              setRestartState("error");
              toast.error(m.computer_restart_error());
            }
          }),
        () =>
          settle(() => {
            setRestartState("error");
            toast.error(m.computer_restart_error());
          }),
      );
  };
  return {
    ...slots,
    upgrading: upgrade.state === "running",
    restartState,
    runUpgrade,
    runRestart,
  };
}
