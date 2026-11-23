import type { ComputerUpgradeProgress, ComputerUpgradeStatus } from "./computer.schemas";

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

export function upgradeProgressActive(
  progress: ComputerUpgradeProgress | undefined,
  now = Date.now(),
  statusKind?: ComputerUpgradeStatus["status"],
): boolean {
  if (!progress) return false;
  if (progress.switchState === "pending")
    return statusKind !== "failed" && now < progress.expiresAt;
  if (progress.switchState === "target_online") return now < progress.expiresAt;
  if (progress.switchState === "confirmed") {
    const hasWaiting = progress.workspaces.some((row) => row.state === "waiting");
    if (!hasWaiting) return false;
    return progress.reconnectUntil === undefined || now < progress.reconnectUntil;
  }
  return false;
}

export function upgradeFollowActive(
  status: ComputerUpgradeStatus | null | undefined,
  now = Date.now(),
): boolean {
  return (
    upgradeRunning(status, now) || upgradeProgressActive(status?.progress, now, status?.status)
  );
}

export type UpgradeFollowObservation = {
  isError: boolean;
  isFetching: boolean;
  data: ComputerUpgradeStatus | null | undefined;
};

export function settledUpgradeFollow(
  observation: UpgradeFollowObservation | undefined,
  now = Date.now(),
): { status: ComputerUpgradeStatus | null | undefined } | undefined {
  if (!observation || observation.isFetching) return undefined;
  if (observation.isError) return { status: undefined };
  if (observation.data !== undefined && !upgradeFollowActive(observation.data, now))
    return { status: observation.data };
  return undefined;
}
