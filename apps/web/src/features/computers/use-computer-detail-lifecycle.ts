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
  hasTrustedUpgradeProgress,
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

export function isStaleCachedAcceptedForTerminalStored(
  liveData: ComputerUpgradeStatus | null | undefined,
  storedUpgrade: ComputerUpgradeStatus | undefined,
): boolean {
  return Boolean(
    liveData?.status === "accepted" &&
    storedUpgrade &&
    storedUpgrade.requestId === liveData.requestId &&
    (storedUpgrade.status === "failed" || storedUpgrade.status === "completed"),
  );
}

export function isUnconfirmedPriorCachedAccepted(
  liveStatus:
    | {
        data: ComputerUpgradeStatus | null | undefined;
        dataUpdatedAt?: number;
      }
    | undefined,
  upgradeRequestState: ComputerUpgradeRequest["state"],
  mountedAt: number | undefined,
): boolean {
  return Boolean(
    mountedAt !== undefined &&
    upgradeRequestState !== "accepted" &&
    liveStatus?.data?.status === "accepted" &&
    !hasTrustedUpgradeProgress(liveStatus.data.progress) &&
    (liveStatus.dataUpdatedAt ?? 0) < mountedAt,
  );
}

export function resolveLiveUpgradeOutcome(input: {
  liveStatus:
    | {
        data: ComputerUpgradeStatus | null | undefined;
        dataUpdatedAt?: number;
        isError: boolean;
        isFetching: boolean;
        error: unknown;
      }
    | undefined;
  upgradeRequestState: ComputerUpgradeRequest["state"];
  storedOutcome: ComputerUpgradeOutcome | undefined;
  storedUpgrade?: ComputerUpgradeStatus;
  mountedAt?: number;
}): ComputerUpgradeOutcome | undefined {
  const { liveStatus, upgradeRequestState, storedOutcome, storedUpgrade, mountedAt } = input;
  if (!liveStatus || liveStatus.data === null) return undefined;
  if (liveStatus.isError && !liveStatus.isFetching)
    return { state: "failed", failure: describeUpgradeRequestError(liveStatus.error) };
  if (liveStatus.data) {
    if (isStaleCachedAcceptedForTerminalStored(liveStatus.data, storedUpgrade))
      return storedOutcome;
    if (isUnconfirmedPriorCachedAccepted(liveStatus, upgradeRequestState, mountedAt))
      return storedOutcome?.state === "running" ? undefined : storedOutcome;
    return upgradeOutcome(liveStatus.data);
  }
  if (upgradeRequestState === "accepted") return { state: "running" };
  return storedOutcome?.state === "running" ? undefined : storedOutcome;
}

export function isUpgradeStatusCheckPending(input: {
  followedUpgradeId: string | null;
  liveStatus:
    | {
        data: ComputerUpgradeStatus | null | undefined;
        dataUpdatedAt?: number;
        isError: boolean;
        isFetching: boolean;
      }
    | undefined;
  upgradeRequestState?: ComputerUpgradeRequest["state"];
  mountedAt?: number;
}): boolean {
  return Boolean(
    input.followedUpgradeId &&
    input.liveStatus &&
    (input.liveStatus.data === undefined ||
      isUnconfirmedPriorCachedAccepted(
        input.liveStatus,
        input.upgradeRequestState ?? "idle",
        input.mountedAt,
      )),
  );
}

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
  const mountedAtRef = useRef(Date.now());
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
  const liveUpgrade = resolveLiveUpgradeOutcome({
    liveStatus,
    upgradeRequestState: upgradeRequest.state,
    storedOutcome,
    storedUpgrade,
    mountedAt: mountedAtRef.current,
  });
  const statusCheckPending = isUpgradeStatusCheckPending({
    followedUpgradeId,
    liveStatus,
    upgradeRequestState: upgradeRequest.state,
    mountedAt: mountedAtRef.current,
  });
  const liveNotFound = liveStatus?.data === null;
  // A stored success is history: the loader's version already includes it.
  const upgrade: ComputerUpgradeOutcome | { state: "idle" } =
    upgradeRequest.state === "requesting"
      ? { state: "running" }
      : upgradeRequest.state === "refused"
        ? { state: "failed", failure: upgradeRequest }
        : liveNotFound
          ? { state: "idle" }
          : (liveUpgrade ??
            (storedOutcome &&
            storedOutcome.state !== "succeeded" &&
            !(storedOutcome.state === "running" && statusCheckPending)
              ? storedOutcome
              : { state: "idle" }));
  const activeLiveStatus =
    (liveStatus?.isError && !liveStatus.isFetching) ||
    isStaleCachedAcceptedForTerminalStored(liveStatus?.data, storedUpgrade) ||
    isUnconfirmedPriorCachedAccepted(liveStatus, upgradeRequest.state, mountedAtRef.current)
      ? undefined
      : (liveStatus?.data ?? undefined);
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
      statusCheckPending ||
      (isLocalOwner &&
        upgradeProgressActive(activeLiveStatus?.progress, Date.now(), activeLiveStatus?.status)),
    restartState,
    runUpgrade,
    runRestart,
  };
}
