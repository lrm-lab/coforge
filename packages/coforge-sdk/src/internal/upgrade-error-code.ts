/**
 * Stable, machine-readable reasons a Computer upgrade did not complete, carried on the wire in
 * `ComputerUpgradeResult.errorCode` and, locally between the Coordinator and a Workspace daemon,
 * on `DaemonCommandResponse.errorCode`. One owner, same
 * discipline as `RUNTIME_PROVIDER`: every throw site names one of these values instead of a
 * caller parsing `error`'s free text.
 *
 * - `OPERATION_PENDING`: `MachineSupervisor.recordUpgrade` refused because a previous operation
 *   on this Workspace has not left a receipt yet (or the Coordinator could not tell whether its
 *   job is still alive). Covers what would otherwise be a separate "genuinely in flight" code -
 *   the Coordinator has no way to probe the external job's liveness, only whether a receipt or
 *   the pending TTL has arrived, so one code covers both until that changes.
 * - `LAUNCHES_PAUSED`: reserved by the installer contract; no current path refuses with it.
 * - `LAUNCH_FAILED`: `recordUpgrade` accepted the request but the external upgrade job itself
 *   could not be started.
 * - `UPDATE_*` other than `UPDATE_DOWNLOAD_FAILED`: reused verbatim from
 *   `packages/computer/src/updater.ts`'s `UpdateError.code`, surfaced when the job fails before
 *   any switch and there is no previous version to roll back to. `UPDATE_FEED_INVALID` is a
 *   pointer, manifest, or version that does not follow the feed's rules: its content was read
 *   and judged.
 * - `UPDATE_DOWNLOAD_FAILED`: `coforge-installer`'s feed client could not download the `latest`
 *   pointer, a manifest, or an artifact: the feed could not be reached (connect or DNS failure,
 *   a reset connection, an idle timeout) or answered with a non-2xx status. The content was never
 *   judged; the message carries the transport error or the status.
 * - `ROLLED_BACK` / `ROLLBACK_FAILED`: the job attempted a switch, it failed, and it either
 *   restored the previous version or could not (`coforge-installer`'s upgrade transaction).
 * - `DOWNGRADE_REFUSED`: the requested version is older than the installed one, and the
 *   upgrade did not pass `--allow-downgrade` (`coforge-installer`'s upgrade transaction). Nothing
 *   changed; the same request with the flag is the way to go back to an older version.
 * - `EXPIRED_WITHOUT_RECEIPT`: the job never left a receipt before the pending TTL passed
 *   (`computer-upgrade-receipts.ts`).
 * - `INSTALLER_UNAVAILABLE` / `INSTALLER_INCOMPATIBLE`: `coforge-installer` never ran an
 *   operation. It could not be fetched from the release feed (or its pointer was unusable), or a
 *   protocol gate refused it (the release needs a newer installer protocol than the one fetched).
 *   Both leave the installation untouched; an installer that ran reports them with exit 1.
 */
export const UPGRADE_ERROR_CODE = {
  OPERATION_PENDING: "UPGRADE_OPERATION_PENDING",
  LAUNCHES_PAUSED: "UPGRADE_LAUNCHES_PAUSED",
  LAUNCH_FAILED: "UPGRADE_LAUNCH_FAILED",
  UPDATE_BUSY: "UPDATE_BUSY",
  UPDATE_FEED_INVALID: "UPDATE_FEED_INVALID",
  UPDATE_DOWNLOAD_FAILED: "UPDATE_DOWNLOAD_FAILED",
  UPDATE_INTEGRITY_FAILED: "UPDATE_INTEGRITY_FAILED",
  UPDATE_NO_ROLLBACK: "UPDATE_NO_ROLLBACK",
  UPDATE_UNSUPPORTED_TARGET: "UPDATE_UNSUPPORTED_TARGET",
  ROLLED_BACK: "UPGRADE_ROLLED_BACK",
  ROLLBACK_FAILED: "UPGRADE_ROLLBACK_FAILED",
  DOWNGRADE_REFUSED: "UPGRADE_DOWNGRADE_REFUSED",
  EXPIRED_WITHOUT_RECEIPT: "UPGRADE_EXPIRED_WITHOUT_RECEIPT",
  INSTALLER_UNAVAILABLE: "UPGRADE_INSTALLER_UNAVAILABLE",
  INSTALLER_INCOMPATIBLE: "UPGRADE_INSTALLER_INCOMPATIBLE",
} as const;
export type UpgradeErrorCode = (typeof UPGRADE_ERROR_CODE)[keyof typeof UPGRADE_ERROR_CODE];
export const UPGRADE_ERROR_CODE_VALUES = Object.values(UPGRADE_ERROR_CODE) as [
  UpgradeErrorCode,
  ...UpgradeErrorCode[],
];
const UPGRADE_ERROR_CODES: ReadonlySet<string> = new Set(UPGRADE_ERROR_CODE_VALUES);
/** The known UpgradeErrorCode a wire/local value names, or undefined - including for a
 * well-formed but not-yet-known code, which callers must treat as "unknown", never reject. */
export function parseUpgradeErrorCode(value: unknown): UpgradeErrorCode | undefined {
  return typeof value === "string" && UPGRADE_ERROR_CODES.has(value)
    ? (value as UpgradeErrorCode)
    : undefined;
}
/** Shape every upgrade error code must satisfy, known or not: matches `diagnosticErrorCode`'s
 * existing low-cardinality-identifier convention. A decoder rejects a value that fails this, but
 * never rejects one that merely names a code this build has not learned about yet. */
export const UPGRADE_ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,63}$/;
