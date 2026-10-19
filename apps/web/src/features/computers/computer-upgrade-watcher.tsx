import { useEffect } from "react";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";

import { useAppToast } from "#src/components/ui/toast";
import {
  computerUpgradeStatusQuery,
  describeComputerUpgradeSuccess,
  followedComputerUpgradesQuery,
  unfollowComputerUpgrade,
  upgradeRunning,
  type FollowedComputerUpgrade,
} from "./computer-upgrade-status";
import type { ComputerUpgradeStatus } from "./computer.schemas";

/**
 * Polls every followed upgrade from the Workspace shell, so going to Chat, Members or another
 * Computer never loses one. It alone settles each: it stops following it, has the Computers pages
 * re-read it, and confirms with a toast an upgrade this tab started. A failure gets no toast; it
 * stays on the Computer, which the server keeps (§13).
 */
export function ComputerUpgradeWatcher() {
  const queryClient = useQueryClient();
  const router = useRouter();
  const toast = useAppToast();
  const followed = useQuery(followedComputerUpgradesQuery).data ?? [];
  const statuses = useQueries({
    queries: followed.map(({ computerId, requestId }) =>
      computerUpgradeStatusQuery(computerId, requestId),
    ),
  });
  // A status that could not be read settles too, with nothing changed on the server.
  const settled = followed.flatMap(
    (
      upgrade,
      index,
    ): { upgrade: FollowedComputerUpgrade; status: ComputerUpgradeStatus | undefined }[] => {
      const status = statuses[index];
      if (status?.isError) return [{ upgrade, status: undefined }];
      return status?.data && !upgradeRunning(status.data) ? [{ upgrade, status: status.data }] : [];
    },
  );
  const settledIds = settled.map(({ upgrade }) => upgrade.requestId).join(",");
  useEffect(() => {
    let changed = false;
    for (const { upgrade, status } of settled) {
      if (!unfollowComputerUpgrade(queryClient, upgrade.requestId) || !status) continue;
      changed = true;
      if (upgrade.startedHere && status.status === "completed" && status.computerVersion)
        toast.success(describeComputerUpgradeSuccess(status.computerVersion));
    }
    // Only the Computers routes show an upgrade; the shell and other pages keep their data.
    if (changed)
      void router.invalidate({
        filter: (match) => match.routeId.startsWith("/w/$workspaceSlug/_computers"),
      });
  }, [settledIds]);
  return null;
}
