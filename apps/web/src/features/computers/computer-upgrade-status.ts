import { queryOptions, skipToken, type QueryClient } from "@tanstack/react-query";

import { m } from "#src/paraglide/messages";
import {
  UPGRADE_DEADLINE_MARGIN_MS,
  settledUpgradeFollow,
  upgradeRunning,
} from "./computer-upgrade-follow";
import type { ComputerUpgradeStatus } from "./computer.schemas";
import { readComputerUpgradeStatus } from "./computers.functions";

export { UPGRADE_DEADLINE_MARGIN_MS, settledUpgradeFollow, upgradeRunning };
export type { UpgradeFollowObservation } from "./computer-upgrade-follow";

const UPGRADE_POLL_INTERVAL_MS = 2_000;

/** A status is read for the last time once it has settled, or failed to read. */
function upgradeStatusSettled({
  data,
  status,
}: {
  data: ComputerUpgradeStatus | undefined;
  status: "pending" | "error" | "success";
}) {
  return status === "error" || (data !== undefined && !upgradeRunning(data));
}

/**
 * One upgrade's status, polled until it settles. `ComputerUpgradeWatcher` is its only poller;
 * every other reader observes it with `enabled: false`.
 */
export function computerUpgradeStatusQuery(computerId: string, requestId: string) {
  return queryOptions({
    queryKey: ["computers", "upgrade", computerId, requestId],
    queryFn: () => readComputerUpgradeStatus({ data: { computerId, requestId } }),
    refetchInterval: (query) =>
      upgradeStatusSettled(query.state) ? false : UPGRADE_POLL_INTERVAL_MS,
    // An error stops the timer. The query stays invalidated, so opening Computers fetches
    // once more; the watcher keeps that in-flight read followed (`settledUpgradeFollow`).
    staleTime: (query) => (upgradeStatusSettled(query.state) ? Infinity : 0),
  });
}

/** An upgrade the watcher follows; `startedHere` when this tab's own click started it. */
export type FollowedComputerUpgrade = {
  computerId: string;
  requestId: string;
  startedHere: boolean;
};

/**
 * The upgrades this tab follows, kept in the app's QueryClient so they outlive every route. Client
 * state only: no read fills it, and it is not kept across a reload (`persisted-queries.ts`).
 */
export const followedComputerUpgradesQuery = queryOptions<FollowedComputerUpgrade[]>({
  queryKey: ["computers", "upgrades", "followed"],
  queryFn: skipToken,
  staleTime: Infinity,
  gcTime: Infinity,
});

/** Starts following an upgrade, or marks one already followed as started here. */
export function followComputerUpgrade(queryClient: QueryClient, upgrade: FollowedComputerUpgrade) {
  const current = queryClient.getQueryData(followedComputerUpgradesQuery.queryKey) ?? [];
  const known = current.find(({ requestId }) => requestId === upgrade.requestId);
  if (known && (known.startedHere || !upgrade.startedHere)) return;
  queryClient.setQueryData(
    followedComputerUpgradesQuery.queryKey,
    known
      ? current.map((followed) => (followed === known ? upgrade : followed))
      : [...current, upgrade],
  );
}

/** Stops following an upgrade; whether it was followed, so its settling is handled once. */
export function unfollowComputerUpgrade(queryClient: QueryClient, requestId: string): boolean {
  const current = queryClient.getQueryData(followedComputerUpgradesQuery.queryKey) ?? [];
  if (!current.some((followed) => followed.requestId === requestId)) return false;
  queryClient.setQueryData(
    followedComputerUpgradesQuery.queryKey,
    current.filter((followed) => followed.requestId !== requestId),
  );
  return true;
}

/**
 * The one-line toast confirmation for a completed upgrade. Per docs/design/toast-vs-inline.md §13,
 * the version itself belongs to the meta line (the page re-reads it once the status is completed);
 * this is only the courtesy that the action the user took succeeded.
 */
export function describeComputerUpgradeSuccess(version: string): string {
  return m.computer_upgrade_succeeded_toast({ version });
}
