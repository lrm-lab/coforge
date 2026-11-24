import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";

import { appNotice } from "#src/components/ui/notice-card";
import { useAppToast } from "#src/components/ui/toast";
import { useBreakpoint } from "#src/hooks/use-breakpoint";
import { m } from "#src/paraglide/messages";
import { useCloudDesktopOrigin } from "./cloud-desktop-origin";
import { cloudDesktopOpening, cloudDesktopUrl, openCloudDesktopWindow } from "./cloud-desktop-url";
import { submitComputerDetailUpgrade } from "./computer-detail-submit-upgrade";
import { computerKind, computerLabel } from "./computer-identity";
import type { BatchUpgradeCandidate, ComputerOverviewItem } from "./computer-overview-model";
import { runComputerRestart } from "./computer-restart-run";
import { computerUpgradeNoticeId } from "./computer-upgrade-status";
import type { ComputerRestartStatus, ComputerUpgradeStatus } from "./computer.schemas";

export function useComputerOverviewActions({
  computers,
  workspaceSlug,
  batchCandidates,
  onUpgradeComputer,
  onRestartComputer,
  onReadRestartStatus,
}: {
  computers: readonly ComputerOverviewItem[];
  workspaceSlug: string;
  batchCandidates: readonly BatchUpgradeCandidate[];
  onUpgradeComputer?: (
    computerId: string,
    requestId: string,
    target?: "runtime" | "image",
  ) => Promise<ComputerUpgradeStatus>;
  onRestartComputer?: (computerId: string, requestId: string) => Promise<ComputerRestartStatus>;
  onReadRestartStatus?: (computerId: string, requestId: string) => Promise<ComputerRestartStatus>;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const toast = useAppToast();
  const desktopOrigin = useCloudDesktopOrigin();
  const phone = !useBreakpoint("sm");
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const [upgradePrompt, setUpgradePrompt] = useState<{
    computer: ComputerOverviewItem;
    targetVersion: string;
  } | null>(null);
  const [batchUpgradeOpen, setBatchUpgradeOpen] = useState(false);
  const [requestingUpgradeIds, setRequestingUpgradeIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [restartingIds, setRestartingIds] = useState<ReadonlySet<string>>(() => new Set());
  const [desktopOverlay, setDesktopOverlay] = useState<{ url: string; title: string } | null>(null);

  const handleOpenDesktop = (computer: ComputerOverviewItem) => {
    if (!desktopOrigin || !computer.ownedByCurrentUser || computerKind(computer.kind) !== "cloud") {
      return;
    }
    const url = cloudDesktopUrl(desktopOrigin, computer.id);
    if (!url) return;
    const opening = cloudDesktopOpening({ online: computer.online, phone });
    if (opening === "offline") toast.error(m.computer_desktop_offline());
    else if (opening === "overlay") setDesktopOverlay({ url, title: computerLabel(computer) });
    else openCloudDesktopWindow(url, computer.id);
  };

  const handleRestart = (computer: ComputerOverviewItem) => {
    if (!onRestartComputer || restartingIds.has(computer.id)) return;
    const setRestarting = (active: boolean) => {
      if (!mountedRef.current) return;
      setRestartingIds((prev) => {
        const next = new Set(prev);
        if (active) next.add(computer.id);
        else next.delete(computer.id);
        return next;
      });
    };
    setRestarting(true);
    let progress: ReturnType<typeof toast.progress> | undefined;
    const failureMessage = {
      deadline: m.computer_restart_error,
      offline: m.computer_restart_offline,
      refused: m.computer_restart_failed,
    };
    void runComputerRestart(
      {
        requestId: crypto.randomUUID(),
        restart: (requestId) => onRestartComputer(computer.id, requestId),
        readStatus: onReadRestartStatus
          ? (requestId) => onReadRestartStatus(computer.id, requestId)
          : undefined,
        pollIntervalMs: 1500,
        maxPolls: 20,
      },
      {
        accepted: () => {
          if (onReadRestartStatus) {
            progress = toast.progress(m.computer_restart_accepted());
          } else {
            setRestarting(false);
            toast.success(m.computer_restart_accepted());
          }
        },
        completed: () => {
          setRestarting(false);
          if (progress) progress.done(m.computer_restart_completed());
          else toast.success(m.computer_restart_completed());
          if (mountedRef.current) void router.invalidate();
        },
        failed: (reason) => {
          setRestarting(false);
          if (progress) progress.fail(failureMessage[reason]());
          else toast.error(failureMessage[reason]());
        },
      },
    );
  };

  const triggerRuntimeUpgrade = async (computer: ComputerOverviewItem, targetVersion: string) => {
    if (!onUpgradeComputer) return;
    const label = computerLabel(computer);
    setRequestingUpgradeIds((prev) => {
      const next = new Set(prev);
      next.add(computer.id);
      return next;
    });
    try {
      await submitComputerDetailUpgrade({
        computerId: computer.id,
        computerName: label,
        workspaceSlug,
        onUpgrade: (requestId, target) => onUpgradeComputer(computer.id, requestId, target),
        queryClient,
        setUpgradeRequest: (request) => {
          if (request.state !== "refused") return;
          appNotice.show({
            id: computerUpgradeNoticeId(computer.id),
            title: `${label} · ${m.computer_upgrade_failed_title({ version: targetVersion })}`,
            body: request.headline,
            actions: [{ label: m.computer_upgrade_notice_dismiss(), onPress: () => undefined }],
          });
        },
        version: targetVersion,
        target: "runtime",
      });
    } finally {
      if (mountedRef.current) {
        setRequestingUpgradeIds((prev) => {
          const next = new Set(prev);
          next.delete(computer.id);
          return next;
        });
      }
    }
  };

  const confirmSingleUpgrade = async () => {
    if (!upgradePrompt) return;
    const { computer, targetVersion } = upgradePrompt;
    setUpgradePrompt(null);
    await triggerRuntimeUpgrade(computer, targetVersion);
  };

  const confirmBatchUpgrade = async () => {
    const targets = batchCandidates
      .map((candidate) => ({
        candidate,
        computer: computers.find((item) => item.id === candidate.computerId),
      }))
      .filter(
        (entry): entry is { candidate: BatchUpgradeCandidate; computer: ComputerOverviewItem } =>
          Boolean(entry.computer),
      );
    setBatchUpgradeOpen(false);
    await Promise.allSettled(
      targets.map(({ computer, candidate }) =>
        triggerRuntimeUpgrade(computer, candidate.targetVersion),
      ),
    );
  };

  return {
    canOpenDesktop: Boolean(desktopOrigin),
    requestingUpgradeIds,
    restartingIds,
    upgradePrompt,
    setUpgradePrompt,
    batchUpgradeOpen,
    setBatchUpgradeOpen,
    desktopOverlay,
    setDesktopOverlay,
    handleOpenDesktop,
    handleRestart,
    confirmSingleUpgrade,
    confirmBatchUpgrade,
  };
}
