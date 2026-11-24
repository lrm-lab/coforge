import { useEffect, useRef } from "react";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMatch, useNavigate, useRouter } from "@tanstack/react-router";

import { appNotice } from "#src/components/ui/notice-card";
import { useAppToast } from "#src/components/ui/toast";
import { m } from "#src/paraglide/messages";
import {
  describeComputerUpgradeFailureNotice,
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
  const seenActiveIdsRef = useRef(new Set<string>());
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
  const activeRuntimeKey = activeRuntime.map((upgrade) => upgrade.requestId).join(",");

  useEffect(() => {
    let changed = false;
    const succeeded: { version: string; computerName?: string }[] = [];
    for (const { upgrade, status } of settled) {
      if (!settleComputerUpgradeFollow(queryClient, upgrade.requestId, status)) continue;
      changed = true;
      if (
        upgrade.startedHere &&
        status?.status === "completed" &&
        computerUpgradeSettledToastable(status) &&
        status.computerVersion
      ) {
        if (upgrade.target !== "image")
          appNotice.dismiss(computerUpgradeNoticeId(upgrade.computerId));
        succeeded.push({
          version: status.computerVersion,
          computerName: upgrade.computerName,
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
    if (successMessage) toast.success(successMessage);

    if (changed)
      void router.invalidate({
        filter: (match) => match.routeId.startsWith("/w/$workspaceSlug/_computers"),
      });
  }, [settledIds]);

  useEffect(() => {
    const currentIds = new Set<string>();
    for (const upgrade of activeRuntime) {
      currentIds.add(upgrade.requestId);
      if (!seenActiveIdsRef.current.has(upgrade.requestId)) {
        appNotice.dismiss(computerUpgradeNoticeId(upgrade.computerId));
      }
    }
    seenActiveIdsRef.current = currentIds;
  }, [activeRuntimeKey]);

  return null;
}
