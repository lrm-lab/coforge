import { useEffect, useRef } from "react";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMatch, useNavigate, useRouter } from "@tanstack/react-router";

import { appNotice } from "#src/components/ui/notice-card";
import { useAppToast } from "#src/components/ui/toast";
import { m } from "#src/paraglide/messages";
import { describeComputerUpgradeFailureNotice } from "./computer-upgrade-progress-view";
import {
  computerUpgradeNoticeId,
  computerUpgradeSettledToastable,
  computerUpgradeStatusQuery,
  describeComputerUpgradeSuccess,
  followedComputerUpgradesQuery,
  settleComputerUpgradeFollow,
  settledUpgradeFollow,
  type FollowedComputerUpgrade,
} from "./computer-upgrade-status";
import type { ComputerUpgradeStatus } from "./computer.schemas";

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
  const progressToastsRef = useRef(new Map<string, ReturnType<typeof toast.progress>>());
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
  const settledIds = settled.map(({ upgrade }) => upgrade.requestId).join(",");
  const activeLocalIds = followed
    .filter((upgrade) => upgrade.startedHere && upgrade.target !== "image")
    .map((upgrade) => upgrade.requestId)
    .join(",");

  useEffect(
    () => () => {
      for (const handle of progressToastsRef.current.values()) handle.dismiss();
      progressToastsRef.current.clear();
    },
    [],
  );

  useEffect(() => {
    const settledSet = new Set(settled.map(({ upgrade }) => upgrade.requestId));
    for (const upgrade of followed) {
      if (!upgrade.startedHere || upgrade.target === "image" || settledSet.has(upgrade.requestId))
        continue;
      if (progressToastsRef.current.has(upgrade.requestId)) continue;
      appNotice.dismiss(computerUpgradeNoticeId(upgrade.computerId));
      const title = upgrade.version
        ? m.computer_upgrade_running_title({ version: upgrade.version })
        : m.computer_upgrade_in_progress();
      progressToastsRef.current.set(
        upgrade.requestId,
        toast.progress(title, { key: upgrade.requestId }),
      );
    }
  }, [activeLocalIds, settledIds]);

  useEffect(() => {
    let changed = false;
    for (const { upgrade, status } of settled) {
      const handle = progressToastsRef.current.get(upgrade.requestId);
      if (!settleComputerUpgradeFollow(queryClient, upgrade.requestId, status)) {
        if (handle) {
          progressToastsRef.current.delete(upgrade.requestId);
          handle.dismiss();
        }
        continue;
      }
      changed = true;
      progressToastsRef.current.delete(upgrade.requestId);
      if (
        upgrade.startedHere &&
        status?.status === "completed" &&
        computerUpgradeSettledToastable(status) &&
        status.computerVersion
      ) {
        if (upgrade.target !== "image") {
          appNotice.dismiss(computerUpgradeNoticeId(upgrade.computerId));
        }
        const message = describeComputerUpgradeSuccess(status.computerVersion);
        if (handle) handle.done(message);
        else toast.success(message);
      } else {
        handle?.dismiss();
        if (upgrade.startedHere && upgrade.target !== "image") {
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
    }
    if (changed)
      void router.invalidate({
        filter: (match) => match.routeId.startsWith("/w/$workspaceSlug/_computers"),
      });
  }, [settledIds]);
  return null;
}
