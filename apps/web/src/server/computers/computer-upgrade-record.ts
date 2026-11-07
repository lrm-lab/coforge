import type { ComputerUpgradeStatus } from "#src/features/computers/computer.schemas";

/** The scope one Computer's upgrade records live under. */
export type ComputerUpgradeScope = { workspaceId: string; computerId: string };
/** One Computer upgrade operation's terminal receipt, as the Daemon reported it. */
export type ReportedComputerUpgradeResult = {
  requestId: string;
  status: "succeeded" | "failed";
  version?: string;
  error?: string;
  errorCode?: string;
  completedAtMs: number;
};
/** The daemon instance and versions a `ready` proved the Computer is running. */
export type ComputerUpgradeIdentity = {
  workerInstanceId: string;
  computerVersion: string;
  daemonVersion: string;
  startedAt: number;
};
/** The stored request record: the public status plus what only the store reads back. */
export type ComputerUpgradeRecord = ComputerUpgradeStatus & {
  previousWorkerInstanceId?: string;
  /** Cloud image replace: the daemon reconnects without recovering this request. */
  completeOnIdentity?: true;
  /** Cloud image replace: complete when the host heartbeat shows this layer. */
  expectedImageId?: string;
};

/** Boundary read of a stored request record; anything malformed reads as no record. */
export function parseComputerUpgradeRecord(raw: string): ComputerUpgradeRecord | undefined {
  try {
    const value = JSON.parse(raw) as ComputerUpgradeRecord;
    if (typeof value?.requestId !== "string" || value.requestId.length === 0) return undefined;
    if (value.status === "accepted")
      return typeof value.expectedVersion === "string" &&
        value.expectedVersion.length > 0 &&
        typeof value.expiresAt === "string" &&
        Number.isFinite(Date.parse(value.expiresAt)) &&
        typeof value.previousWorkerInstanceId === "string" &&
        value.previousWorkerInstanceId.length > 0
        ? value
        : undefined;
    if (value.status === "completed")
      return typeof value.expectedVersion === "string" &&
        value.expectedVersion.length > 0 &&
        typeof value.computerVersion === "string" &&
        value.computerVersion.length > 0 &&
        typeof value.daemonVersion === "string" &&
        value.daemonVersion.length > 0 &&
        typeof value.workerInstanceId === "string" &&
        value.workerInstanceId.length > 0 &&
        typeof value.completedAt === "string" &&
        Number.isFinite(Date.parse(value.completedAt))
        ? value
        : undefined;
    if (value.status === "failed")
      return (value.reason === "timeout" ||
        value.reason === "publication" ||
        value.reason === "evidence" ||
        value.reason === "reported") &&
        (value.error === undefined || typeof value.error === "string") &&
        (value.errorCode === undefined || typeof value.errorCode === "string")
        ? value
        : undefined;
    return value.status === "unknown" && value.reason === "corrupt" ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Boundary read of the stored daemon identity; anything malformed reads as none. */
export function parseComputerUpgradeIdentity(
  raw: string | null,
): ComputerUpgradeIdentity | undefined {
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as ComputerUpgradeIdentity;
    return typeof value.workerInstanceId === "string" &&
      value.workerInstanceId.length > 0 &&
      typeof value.computerVersion === "string" &&
      value.computerVersion.length > 0 &&
      typeof value.daemonVersion === "string" &&
      value.daemonVersion.length > 0 &&
      Number.isSafeInteger(value.startedAt) &&
      value.startedAt >= 0
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

/** The request a Daemon upgrade result belongs to; a report without one is malformed. */
export function reportedRequestId(result: ReportedComputerUpgradeResult): string {
  if (!result.requestId) throw new Error("Computer upgrade result has no request");
  return result.requestId;
}
