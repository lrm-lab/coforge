import { getLogger } from "@logtape/logtape";
import type { ReminderFireResponse, ReminderJob } from "@lrm/coforge-sdk/internal";

const logger = getLogger(["coforge", "daemon", "reminder"]);
export const RETRY_EXHAUSTED_CODE = "REMINDER_DELIVERY_RETRY_EXHAUSTED";

/** The durable step whose retries ran out: the fire request to the cloud, or waking the Agent. */
export type ReminderRetryStage = "fire" | "wake";

/**
 * Why a receipt stopped retrying without delivering. Its presence is what tells a failed occurrence
 * apart from one that ended because the Agent accepted the wake or the cloud declined the fire.
 */
export type ReminderRetryExhausted = {
  code: typeof RETRY_EXHAUSTED_CODE;
  stage: ReminderRetryStage;
  attempts: number;
  /** The receipt's retry deadline, epoch milliseconds. */
  deadline: number;
  /** When the scheduler gave up, epoch milliseconds. */
  exhaustedAt: number;
};

export type ReminderReceipt = {
  workspaceId: string;
  computerId: string;
  agentId: string;
  reminderId: string;
  version: number;
  job: ReminderJob;
  requestId: string;
  firedAtClient: string;
  attempt: number;
  deadline: number;
  nextAt: number;
  serverResult?: ReminderFireResponse["result"];
  serverFired?: boolean;
  serverCatchup?: boolean;
  wakeAccepted: boolean;
  consumed: boolean;
  terminal: boolean;
  retryExhausted?: ReminderRetryExhausted;
};

export interface ReminderReceiptStore {
  read(agentId: string): Promise<ReminderReceipt[]>;
  write(agentId: string, receipts: readonly ReminderReceipt[]): Promise<void>;
}

export const cloudFired = (receipt: ReminderReceipt) =>
  receipt.serverResult === "accepted" && receipt.serverFired === true;

const owesWork = (receipt: ReminderReceipt): boolean =>
  receipt.retryExhausted !== undefined &&
  !receipt.consumed &&
  !receipt.wakeAccepted &&
  receipt.serverResult !== "obsolete";

export const withOwedWorkReopened = (receipt: ReminderReceipt): ReminderReceipt =>
  receipt.terminal && owesWork(receipt) ? { ...receipt, terminal: false } : receipt;

export function receiptKey(agentId: string, reminderId: string, version: number) {
  return `${agentId}:${reminderId}:${version}`;
}

export function logExhausted(
  receipt: ReminderReceipt,
  stage: ReminderRetryStage | "persistence",
  lastFailure: unknown,
  persistenceFailures?: number,
): void {
  const code = (lastFailure as { code?: unknown } | undefined)?.code;
  logger.error("Reminder delivery retries exhausted", {
    event: "reminder.retry_exhausted",
    outcome: "failed",
    code: RETRY_EXHAUSTED_CODE,
    agent_id: receipt.agentId,
    reminder_id: receipt.reminderId,
    // `reminder_version`, not `version`, for the same reason as `reminder.fire_failed`.
    reminder_version: receipt.version,
    stage,
    attempts: receipt.attempt,
    persistence_failures: persistenceFailures,
    retry_deadline: new Date(receipt.deadline).toISOString(),
    error_code: typeof code === "string" || typeof code === "number" ? String(code) : undefined,
    error_name: lastFailure instanceof Error ? lastFailure.name : undefined,
  });
}

export function logFireFailed(receipt: ReminderReceipt, error: unknown): void {
  // Which reminder failed matters when several are scheduled: without the id and the
  // attempt, the log line cannot be told apart across retries (2026-09-23 morning: the
  // server answered every fire with RPC 104 "method not found" and the log named neither).
  logger.error("Reminder fire failed", {
    error,
    event: "reminder.fire_failed",
    outcome: "failed",
    agent_id: receipt.agentId,
    reminder_id: receipt.reminderId,
    // `reminder_version`, not `version`: the structured line already carries the build's
    // `version` (docs/observability/structured-logging.md reserves it), and the two must stay tellable apart.
    reminder_version: receipt.version,
    attempt: receipt.attempt,
    retry_deadline: new Date(receipt.deadline).toISOString(),
  });
}

export function logWakeFailed(receipt: ReminderReceipt, error: unknown): void {
  logger.error("Reminder wake failed", {
    error,
    event: "reminder.wake_failed",
    outcome: "failed",
    agent_id: receipt.agentId,
    reminder_id: receipt.reminderId,
    reminder_version: receipt.version,
    attempt: receipt.attempt,
  });
}
