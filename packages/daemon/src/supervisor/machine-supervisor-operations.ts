/** The Coordinator's local-upgrade vocabulary: the operation record a binding keeps, its
 * states, the pending settler, and the upgrade-history limits (task #417 extraction). */

export type RestartResult =
  | { requestId: string; status: "completed"; instanceId: string }
  /** `by`: what took it over; older receipts without it were cancelled by a stop. */
  | { requestId: string; status: "cancelled"; by?: "stop" | "configure" };

/**
 * The canonical local Computer upgrade operation. `pending` means an external one-shot job was
 * launched and has not supplied terminal evidence yet; `succeeded`/`failed` are the one settled
 * outcome projected to child config/cloud; `acknowledged` means server acceptance and bounded
 * audit history. The immutable result file is evidence applied to this record, not a peer state.
 */
export type UpgradeOperationState = "pending" | "succeeded" | "failed" | "acknowledged";
export type UpgradeOperationTerminal = {
  version?: string;
  error?: string;
  /** See `UPGRADE_ERROR_CODE`. Set only when the job (or the Coordinator, on a launch failure)
   * can name a stable reason for this terminal state. */
  errorCode?: string;
  at: number;
};
export type UpgradeOperation = {
  requestId: string;
  expectedVersion: string;
  state: UpgradeOperationState;
  /** When this machine opened the operation, so a stranded one can be aged out. */
  requestedAt: number;
  terminal?: UpgradeOperationTerminal;
};
/** How many operation records one binding keeps, newest last, including the audit tail. */
export const UPGRADE_OPERATION_HISTORY = 128;
/**
 * How long a pending operation may go without a receipt before it is settled as failed. A job
 * that never ran, or whose receipt was lost, must not hold the single pending slot forever. The
 * margin is deliberate: the server's own request TTL is ten minutes, so anything this old has
 * already been given up on upstream.
 */
export const UPGRADE_OPERATION_PENDING_TTL_MS = 30 * 60_000;

/**
 * What a blocking pending operation resolves to when it turns out to already be settle-able
 * (its job's receipt exists, or it has aged past the pending TTL). Structurally the same shape
 * `completeUpgrade` accepts, so `recordUpgrade` can apply it the same way.
 */
export type PendingUpgradeSettlement = {
  status: "succeeded" | "failed";
} & UpgradeOperationTerminal;

/**
 * Given the pending operation blocking a new `recordUpgrade` call, reports its settlement if one
 * is already available (a receipt, or the pending TTL has passed), or `undefined` if it is
 * genuinely still in flight. Reads only - the caller applies the settlement, since this runs
 * inside `recordUpgrade`'s own serialized mutation and must not re-enter it.
 */
export type PendingUpgradeSettler = (
  workspaceId: string,
  requestId: string,
  requestedAt: number,
) => Promise<PendingUpgradeSettlement | undefined>;

export const LIFECYCLE_FAILURE_OPERATIONS = ["start", "restart", "stop", "configure"] as const;
export type LifecycleFailure = {
  operation: (typeof LIFECYCLE_FAILURE_OPERATIONS)[number];
  message: string;
  at: number;
};
