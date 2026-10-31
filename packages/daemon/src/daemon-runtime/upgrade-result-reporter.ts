import { getLogger } from "@logtape/logtape";
import {
  UPGRADE_ERROR_CODE_PATTERN,
  WORKSPACE_PROTOCOL_MAJOR,
  type ComputerUpgradeRecovery,
  type ComputerUpgradeResult,
} from "@lrm/coforge-sdk/internal";
import type { InstallerRecoveryReport } from "@lrm/coforge-sdk/internal/upgrade-receipt";
import { readRecoveryReport } from "#src/platform/recovery-report-file";
import { launchFailureCooldownMs } from "#src/agent-runtime/launch-failure-backoff";
import type { DaemonConnectionClient } from "#src/connection/daemon-connection-client";
import { diagnosticErrorCode } from "@lrm/coforge-sdk/internal";
import { scheduleUnrefTimer, type UnrefTimerSchedule } from "./unref-timer";

const logger = getLogger(["coforge", "daemon", "runtime", "upgrade-result"]);

/** How often the local config is re-read while it lists a pending upgrade operation. */
export const UPGRADE_RESULT_POLL_MS = 5_000;
/** First retry delay after a failed pass; it doubles up to the cap. */
export const UPGRADE_RESULT_RETRY_BASE_MS = 5_000;
export const UPGRADE_RESULT_RETRY_MAX_MS = 60_000;

/** A terminal upgrade operation carried forward from the Coordinator's durable record. */
export type RecoveredUpgradeResult = {
  requestId: string;
  status: "succeeded" | "failed";
  completedAtMs: number;
  version?: string;
  error?: string;
  /** See `UPGRADE_ERROR_CODE`. */
  errorCode?: string;
  /** The automatic recovery that settled this operation, from `recovery-report.json`. */
  recovery?: ComputerUpgradeRecovery;
  /** Only the recovery is owed - the operation's own result is already settled server-side (or
   * its record is no longer in this Workspace's config). Sent, but never acknowledged to the
   * Coordinator: it has no matching record to settle. */
  recoveryOnly?: true;
};

/** What this Workspace's local config says about its upgrade operations. */
export type UpgradeOperationsReading = {
  /** Terminal operations this Workspace still owes the server a report for. */
  results: RecoveredUpgradeResult[];
  /** Whether an operation still waits for its job's receipt. */
  pending: boolean;
};

export type UpgradeResultReporterOptions = {
  workspaceId: string;
  computerId: string;
  readOperations(): Promise<UpgradeOperationsReading>;
  /** The current transport, read on every send: the runtime replaces it across starts. */
  transport(): Pick<DaemonConnectionClient, "sendUpgradeResult">;
  /** Tells the Coordinator the server accepted a result. Absent: nothing to acknowledge. */
  acknowledge?(requestId: string): Promise<void>;
  schedule?: UnrefTimerSchedule;
};

/**
 * Settles this Workspace's terminal Computer upgrade results with the server: each result is
 * sent, and acknowledged to the Coordinator only once the server accepted it. While the local
 * config lists a pending operation, it is re-read every `UPGRADE_RESULT_POLL_MS`, so a job that
 * fails before stopping this process (a download) is reported by this process; the Coordinator
 * turns every pending operation terminal itself (receipt or TTL). A failed pass is retried with
 * bounded backoff, pending or not. One pass runs at a time; triggers during a pass run it once more. Between
 * `stop` and the next `start`, triggers do nothing.
 */
export class UpgradeResultReporter {
  readonly #options: UpgradeResultReporterOptions;
  /** Acknowledged by this process: a stale read must not send or acknowledge them again. */
  readonly #acknowledged = new Set<string>();
  /** Recovery reports this process already put on the wire. */
  readonly #recoverySent = new Set<string>();
  #open = false;
  /** Bumped by `start` and `stop`, so a pass from before neither continues nor schedules. */
  #generation = 0;
  #pass: Promise<void> | undefined;
  #rerun = false;
  #cancelTimer: (() => void) | undefined;
  #failures = 0;

  constructor(options: UpgradeResultReporterOptions) {
    this.#options = options;
  }

  start(): void {
    this.#generation += 1;
    this.#open = true;
  }

  /** Cancels the timer and any rerun; a pass still running sends and acknowledges nothing more. */
  stop(): void {
    this.#generation += 1;
    this.#open = false;
    // A pass of the closed generation ends on its own; a later start must not wait behind it.
    this.#pass = undefined;
    this.#rerun = false;
    this.#cancelTimer?.();
    this.#cancelTimer = undefined;
    this.#failures = 0;
  }

  /** Reports every terminal result not yet acknowledged. Never rejects. */
  report(): Promise<void> {
    if (!this.#open) return Promise.resolve();
    if (this.#pass) {
      this.#rerun = true;
      return this.#pass;
    }
    const pass = this.#run().finally(() => {
      // `stop` may already have dropped this pass, and a `start` begun another.
      if (this.#pass === pass) this.#pass = undefined;
    });
    this.#pass = pass;
    return pass;
  }

  /**
   * Reports a request the Coordinator refused, or whose launch failed, once and without retry:
   * nothing durable holds it, and the server times the request out otherwise. Then runs a pass,
   * so a failure the Coordinator did record is acknowledged promptly.
   */
  async reportRefused(result: RecoveredUpgradeResult): Promise<void> {
    if (!this.#open) return;
    await this.#options
      .transport()
      .sendUpgradeResult?.(this.#wireResult(result))
      .catch((error) => {
        logger.error("Refused Computer upgrade could not be reported", {
          event: "upgrade:refusal_report_failed",
          request_id: result.requestId,
          workspace_id: this.#options.workspaceId,
          error_code: diagnosticErrorCode(error),
        });
      });
    void this.report();
  }

  async #run(): Promise<void> {
    const generation = this.#generation;
    const current = () => generation === this.#generation;
    let outcome: { failed: boolean; pending: boolean };
    do {
      this.#rerun = false;
      outcome = await this.#settle(current);
    } while (this.#rerun && current());
    if (!current()) return;
    this.#cancelTimer?.();
    this.#cancelTimer = undefined;
    this.#failures = outcome.failed ? this.#failures + 1 : 0;
    const delay = outcome.failed
      ? launchFailureCooldownMs(
          this.#failures,
          UPGRADE_RESULT_RETRY_BASE_MS,
          UPGRADE_RESULT_RETRY_MAX_MS,
        )
      : outcome.pending
        ? UPGRADE_RESULT_POLL_MS
        : undefined;
    if (delay !== undefined)
      this.#cancelTimer = (this.#options.schedule ?? scheduleUnrefTimer)(() => {
        this.#cancelTimer = undefined;
        return this.report();
      }, delay);
  }

  /** One read of the config and one send and acknowledgement per unsettled result. */
  async #settle(current: () => boolean): Promise<{ failed: boolean; pending: boolean }> {
    let reading: UpgradeOperationsReading;
    try {
      reading = await this.#options.readOperations();
    } catch (error) {
      logger.error("Computer upgrade results could not be read", {
        event: "upgrade:result_read_failed",
        workspace_id: this.#options.workspaceId,
        error_code: diagnosticErrorCode(error),
        outcome: "failed",
      });
      return { failed: true, pending: false };
    }
    let failed = false;
    for (const result of reading.results) {
      if (!current()) break;
      const acknowledged = this.#acknowledged.has(result.requestId);
      const owesRecovery =
        result.recovery !== undefined && !this.#recoverySent.has(result.requestId);
      // A recovery-only result is never acknowledged — once its recovery was sent it is done, or
      // every pass (and every transport replacement) would offer it to the server again.
      if (!owesRecovery && (acknowledged || result.recoveryOnly)) continue;
      const transport = this.#options.transport();
      if (!transport.sendUpgradeResult) break;
      try {
        // False is a replay of a result the server already accepted: acknowledge it again. A
        // recovery-bearing result is a second report for the same requestId, not a replay.
        await transport.sendUpgradeResult(this.#wireResult(result));
        if (!current()) break;
        if (result.recovery) this.#recoverySent.add(result.requestId);
        // A recovery-only result settles nothing on the Coordinator's side; an already
        // acknowledged operation is not acknowledged again.
        if (!acknowledged && !result.recoveryOnly) {
          await this.#options.acknowledge?.(result.requestId);
          this.#acknowledged.add(result.requestId);
        }
      } catch (error) {
        failed = true;
        logger.error("Computer upgrade result report failed", {
          event: "upgrade:result_report_failed",
          request_id: result.requestId,
          workspace_id: this.#options.workspaceId,
          error_code: diagnosticErrorCode(error),
          outcome: "failed",
        });
      }
    }
    return { failed, pending: reading.pending };
  }

  #wireResult(result: RecoveredUpgradeResult): ComputerUpgradeResult {
    return {
      protocolMajor: WORKSPACE_PROTOCOL_MAJOR,
      requestId: result.requestId,
      workspaceId: this.#options.workspaceId,
      computerId: this.#options.computerId,
      status: result.status,
      completedAtMs: result.completedAtMs,
      ...(result.version ? { version: result.version } : {}),
      ...(result.error ? { error: result.error } : {}),
      ...(result.errorCode ? { errorCode: result.errorCode } : {}),
      ...(result.recovery ? { recovery: result.recovery } : {}),
    };
  }
}

/**
 * Reads the upgrade operations the Coordinator wrote into this Workspace's config: the terminal
 * ones it still owes the server a report for, and whether one is still pending. Acknowledged
 * ones are audit history. An error code is kept when it is well formed, known to this build or
 * not.
 */
export function upgradeOperationsInConfig(
  config: unknown,
  now: () => number = Date.now,
): UpgradeOperationsReading {
  const operations = (
    config as {
      upgradeOperations?: {
        requestId?: unknown;
        state?: unknown;
        terminal?: { version?: unknown; error?: unknown; errorCode?: unknown; at?: unknown };
      }[];
    } | null
  )?.upgradeOperations;
  if (!Array.isArray(operations)) return { results: [], pending: false };
  const results = operations.flatMap((operation): RecoveredUpgradeResult[] => {
    if (operation.state !== "succeeded" && operation.state !== "failed") return [];
    if (typeof operation.requestId !== "string" || !operation.requestId) return [];
    const { version, error, errorCode, at } = operation.terminal ?? {};
    return [
      {
        requestId: operation.requestId,
        status: operation.state,
        completedAtMs: Number.isSafeInteger(at) ? (at as number) : now(),
        ...(typeof version === "string" && version ? { version } : {}),
        ...(typeof error === "string" && error ? { error } : {}),
        ...(typeof errorCode === "string" && UPGRADE_ERROR_CODE_PATTERN.test(errorCode)
          ? { errorCode }
          : {}),
      },
    ];
  });
  return {
    results,
    pending: operations.some((operation) => operation.state === "pending"),
  };
}

/**
 * The `readOperations` the runtime wiring supplies: the Workspace config's upgrade operations
 * with the machine's recovery report folded in. A report that cannot be read is no reason to
 * hold the results back.
 */
export async function readUpgradeOperationsWithRecovery(
  loadConfig: () => Promise<unknown>,
): Promise<UpgradeOperationsReading> {
  return attachRecoveryReport(
    upgradeOperationsInConfig(await loadConfig()),
    await readRecoveryReport().catch(() => undefined),
  );
}

/**
 * Folds the installer's recovery report into a config reading. The report names the upgrade it
 * settled, so it is attached to that operation's result; when this Workspace's config no longer
 * lists the operation (already acknowledged), a recovery-only result still carries it to the
 * server. A report without a request id - written by an installer from before the linkage - is
 * left unreported.
 */
export function attachRecoveryReport(
  reading: UpgradeOperationsReading,
  report: InstallerRecoveryReport | undefined,
): UpgradeOperationsReading {
  if (!report?.requestId) return reading;
  const recovery: ComputerUpgradeRecovery = {
    outcome: report.outcome,
    ...(report.restoredVersion ? { restoredVersion: report.restoredVersion } : {}),
    attempts: report.attempts,
    finishedAtMs: report.finishedAt * 1000,
    ...(report.message ? { message: report.message } : {}),
  };
  if (reading.results.some((result) => result.requestId === report.requestId))
    return {
      ...reading,
      results: reading.results.map((result) =>
        result.requestId === report.requestId ? { ...result, recovery } : result,
      ),
    };
  return {
    ...reading,
    results: [
      ...reading.results,
      // Recovery means the upgrade it settled did not promote: the standalone result is a failed
      // one, its recovery field saying how the machine ended.
      {
        requestId: report.requestId,
        status: "failed",
        completedAtMs: recovery.finishedAtMs,
        recovery,
        recoveryOnly: true,
      },
    ],
  };
}
