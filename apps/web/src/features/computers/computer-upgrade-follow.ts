import type { ComputerUpgradeStatus } from "./computer.schemas";

/**
 * How long past the server's deadline an `accepted` status is still taken at its word. The server
 * times a request out at `expiresAt` itself; this is only a safety net for a status that never
 * moves on.
 */
export const UPGRADE_DEADLINE_MARGIN_MS = 90_000;

/** Whether an upgrade still reads as running: accepted, and not long past its deadline. */
export function upgradeRunning(
  status: ComputerUpgradeStatus | null | undefined,
  now = Date.now(),
): boolean {
  return (
    status?.status === "accepted" &&
    Date.parse(status.expiresAt) + UPGRADE_DEADLINE_MARGIN_MS >= now
  );
}

/**
 * What the watcher currently sees of one followed upgrade. A recovery fetch keeps the previous
 * error until it returns, so `isError` and `isFetching` are true together and `data` is still the
 * last accepted status.
 */
export type UpgradeFollowObservation = {
  isError: boolean;
  isFetching: boolean;
  data: ComputerUpgradeStatus | undefined;
};

/**
 * Whether the watcher should stop following. `undefined` means keep the follow.
 * A read that failed and is idle settles with no status: nothing on the server changed.
 * An in-flight read is not settled, even while it still reports that error.
 */
export function settledUpgradeFollow(
  observation: UpgradeFollowObservation | undefined,
): { status: ComputerUpgradeStatus | undefined } | undefined {
  if (!observation || observation.isFetching) return undefined;
  if (observation.isError) return { status: undefined };
  if (observation.data && !upgradeRunning(observation.data)) return { status: observation.data };
  return undefined;
}
