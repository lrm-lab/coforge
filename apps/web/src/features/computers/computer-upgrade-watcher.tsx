import { useEffect, useRef } from "react";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMatch, useNavigate, useRouter } from "@tanstack/react-router";

import { appNotice } from "#src/components/ui/notice-card";
import { useAppToast } from "#src/components/ui/toast";
import { RESULT_TOAST_MS } from "#src/components/ui/toast-model";
import { m } from "#src/paraglide/messages";
import {
  describeComputerUpgradeFailureNotice,
  describeComputerUpgradeProgressToast,
  describeComputerUpgradeSuccessBatch,
} from "./computer-upgrade-progress-view";
import {
  computerUpgradeNoticeId,
  computerUpgradeSettledToastable,
  computerUpgradeStatusQuery,
  followedComputerUpgradesQuery,
  settleComputerUpgradeFollow,
  settledUpgradeFollow,
  type FollowedComputerUpgrade,
} from "./computer-upgrade-status";
import type { ComputerUpgradeStatus } from "./computer.schemas";

const UPGRADE_PROGRESS_TOAST_KEY = "computer-upgrades";

export function ComputerUpgradeWatcher() {
  const queryClient = useQueryClient();
  const router = useRouter();
  const navigate = useNavigate();
  const viewingComputerId = useMatch({
    from: "/w/$workspaceSlug/_computers/computer/$computerId",
    shouldThrow: false,
    select: (match) => match.params.computerId,
  });
  const toast = useAppToast();
  const progressToastRef = useRef<ReturnType<typeof toast.progress> | null>(null);
  const resumeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seenActiveIdsRef = useRef(new Set<string>());
  const latestActiveTitleRef = useRef<string | null>(null);
  const followed = useQuery(followedComputerUpgradesQuery).data ?? [];
  const statuses = useQueries({
    queries: followed.map(({ computerId, requestId }) =>
      computerUpgradeStatusQuery(computerId, requestId),
    ),
  });
  const settled = followed.flatMap(
    (
      upgrade,
      index,
    ): { upgrade: FollowedComputerUpgrade; status: ComputerUpgradeStatus | null | undefined }[] => {
      const decision = settledUpgradeFollow(statuses[index]);
      return decision ? [{ upgrade, status: decision.status }] : [];
    },
  );
  const settledSet = new Set(settled.map(({ upgrade }) => upgrade.requestId));
  const settledIds = settled.map(({ upgrade }) => upgrade.requestId).join(",");
  const activeRuntime = followed.filter(
    (upgrade) =>
      upgrade.startedHere && upgrade.target !== "image" && !settledSet.has(upgrade.requestId),
  );
  const activeRuntimeTitle = describeComputerUpgradeProgressToast(activeRuntime);
  const activeRuntimeKey = activeRuntime.map((upgrade) => upgrade.requestId).join(",");

  useEffect(
    () => () => {
      if (resumeTimerRef.current !== null) {
        clearTimeout(resumeTimerRef.current);
        resumeTimerRef.current = null;
      }
      progressToastRef.current?.dismiss();
      progressToastRef.current = null;
    },
    [],
  );

  useEffect(() => {
    let changed = false;
    const succeeded: { version: string; computerName?: string; isRuntime: boolean }[] = [];
    for (const { upgrade, status } of settled) {
      if (!settleComputerUpgradeFollow(queryClient, upgrade.requestId, status)) continue;
      changed = true;
      if (
        upgrade.startedHere &&
        status?.status === "completed" &&
        computerUpgradeSettledToastable(status) &&
        status.computerVersion
      ) {
        const isRuntime = upgrade.target !== "image";
        if (isRuntime) appNotice.dismiss(computerUpgradeNoticeId(upgrade.computerId));
        succeeded.push({
          version: status.computerVersion,
          computerName: upgrade.computerName,
          isRuntime,
        });
      } else if (upgrade.startedHere && upgrade.target !== "image") {
        const failureNotice = describeComputerUpgradeFailureNotice({ upgrade, status });
        if (failureNotice) {
          const viewingComputer = viewingComputerId === upgrade.computerId;
          const actions = [
            { label: m.computer_upgrade_notice_dismiss(), onPress: () => undefined },
            ...(!viewingComputer && upgrade.workspaceSlug
              ? [
                  {
                    label: m.computer_upgrade_notice_view_computer(),
                    onPress: () => {
                      if (!upgrade.workspaceSlug) return;
                      void navigate({
                        to: "/w/$workspaceSlug/computer/$computerId",
                        params: {
                          workspaceSlug: upgrade.workspaceSlug,
                          computerId: upgrade.computerId,
                        },
                      });
                    },
                  },
                ]
              : []),
          ];
          appNotice.show({ ...failureNotice, actions });
        }
      }
    }

    const successMessage = describeComputerUpgradeSuccessBatch(succeeded);
    if (successMessage) {
      if (resumeTimerRef.current !== null) {
        clearTimeout(resumeTimerRef.current);
        resumeTimerRef.current = null;
      }
      const hadRuntimeSuccess = succeeded.some((item) => item.isRuntime);
      if (hadRuntimeSuccess && progressToastRef.current) {
        progressToastRef.current.done(successMessage);
        progressToastRef.current = null;
      } else {
        toast.success(successMessage);
      }
      if (activeRuntimeTitle !== null) {
        resumeTimerRef.current = setTimeout(() => {
          resumeTimerRef.current = null;
          const nextTitle = latestActiveTitleRef.current;
          if (nextTitle) {
            progressToastRef.current = toast.progress(nextTitle, {
              key: UPGRADE_PROGRESS_TOAST_KEY,
            });
          }
        }, RESULT_TOAST_MS);
      }
    }

    if (changed)
      void router.invalidate({
        filter: (match) => match.routeId.startsWith("/w/$workspaceSlug/_computers"),
      });
  }, [settledIds]);

  useEffect(() => {
    latestActiveTitleRef.current = activeRuntimeTitle;
    let startedNew = false;
    const currentIds = new Set<string>();
    for (const upgrade of activeRuntime) {
      currentIds.add(upgrade.requestId);
      if (!seenActiveIdsRef.current.has(upgrade.requestId)) {
        startedNew = true;
        appNotice.dismiss(computerUpgradeNoticeId(upgrade.computerId));
      }
    }
    seenActiveIdsRef.current = currentIds;

    if (activeRuntimeTitle === null) {
      if (resumeTimerRef.current !== null) {
        clearTimeout(resumeTimerRef.current);
        resumeTimerRef.current = null;
      }
      if (progressToastRef.current) {
        progressToastRef.current.dismiss();
        progressToastRef.current = null;
      }
      return;
    }

    if (startedNew && resumeTimerRef.current !== null) {
      clearTimeout(resumeTimerRef.current);
      resumeTimerRef.current = null;
    }
    if (resumeTimerRef.current !== null) return;

    if (progressToastRef.current) {
      progressToastRef.current.update(activeRuntimeTitle);
    } else {
      progressToastRef.current = toast.progress(activeRuntimeTitle, {
        key: UPGRADE_PROGRESS_TOAST_KEY,
      });
    }
  }, [activeRuntimeKey, activeRuntimeTitle]);

  return null;
}
