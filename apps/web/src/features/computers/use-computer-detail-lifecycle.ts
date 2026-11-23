import { useEffect, useRef, useState } from "react";
import { useQueries, useQueryClient } from "@tanstack/react-query";

import { useAppToast } from "#src/components/ui/toast";
import { m } from "#src/paraglide/messages";
import { runComputerRestart, type ComputerRestartState } from "./computer-restart-run";
import { computerKind } from "./computer-identity";
import { computerDetailUpgradeSlotsFor } from "./computer-detail-upgrade-slots";
import { submitComputerDetailUpgrade } from "./computer-detail-submit-upgrade";
import {
  computerUpgradeStatusQuery,
  upgradeProgressActive,
  upgradeRunning,
} from "./computer-upgrade-status";
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
  ownedByCurrentUser?: boolean;
  computerVersion?: string | null;
  imageVersion?: string | null;
  imageUpdate?: { version: string } | null;
  upgrade?: ComputerUpgradeStatus | null;
  upgradeProgressRequestId?: string;
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
  const [restartState, setRestartState] = useState<ComputerRestartState>("idle");
  const [upgradeRequest, setUpgradeRequest] = useState<ComputerUpgradeRequest>({ state: "idle" });
  const storedUpgrade = input.upgrade ?? undefined;
  const isLocalOwner = computerKind(input.kind) === "local" && Boolean(input.ownedByCurrentUser);
  const followedUpgradeId =
    upgradeRequest.state === "accepted"
      ? upgradeRequest.requestId
      : storedUpgrade && upgradeRunning(storedUpgrade)
        ? storedUpgrade.requestId
        : isLocalOwner &&
            input.upgradeProgressRequestId &&
            (!storedUpgrade || storedUpgrade.requestId === input.upgradeProgressRequestId)
          ? input.upgradeProgressRequestId
          : null;
  const [liveStatus] = useQueries({
    queries: (followedUpgradeId ? [followedUpgradeId] : []).map((requestId) => ({
      ...computerUpgradeStatusQuery(input.computerId, requestId),
      enabled: false,
    })),
  });
  const storedOutcome = storedUpgrade ? upgradeOutcome(storedUpgrade) : undefined;
  const liveUpgrade: ComputerUpgradeOutcome | undefined =
    !liveStatus || liveStatus.data === null
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
  const activeLiveStatus =
    liveStatus?.isError && !liveStatus.isFetching ? undefined : (liveStatus?.data ?? undefined);
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
      liveStatus: activeLiveStatus,
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
    const settle = (state: typeof restartState) => {
      if (mountedRef.current) setRestartState(state);
    };
    let progress: ReturnType<typeof toast.progress> | undefined;
    const failure = {
      deadline: m.computer_restart_error,
      offline: m.computer_restart_offline,
      refused: m.computer_restart_failed,
    };
    void runComputerRestart(
      {
        requestId: crypto.randomUUID(),
        restart: input.onRestart,
        readStatus: input.onReadRestartStatus,
        pollIntervalMs: input.restartPollIntervalMs,
        maxPolls: input.restartMaxPolls,
      },
      {
        accepted: () => {
          settle("accepted");
          if (input.onReadRestartStatus) progress = toast.progress(m.computer_restart_accepted());
          else toast.success(m.computer_restart_accepted());
        },
        completed: () => {
          settle("completed");
          if (progress) progress.done(m.computer_restart_completed());
          else toast.success(m.computer_restart_completed());
        },
        failed: (reason) => {
          settle("error");
          if (progress) progress.fail(failure[reason]());
          else toast.error(failure[reason]());
        },
      },
    );
  };
  return {
    ...slots,
    upgrading:
      upgrade.state === "running" ||
      (isLocalOwner &&
        upgradeProgressActive(activeLiveStatus?.progress, Date.now(), activeLiveStatus?.status)),
    restartState,
    runUpgrade,
    runRestart,
  };
}
