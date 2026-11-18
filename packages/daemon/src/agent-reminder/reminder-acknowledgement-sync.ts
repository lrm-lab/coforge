import { getLogger } from "@logtape/logtape";
import { reminderAcknowledgementIdempotencyKey } from "@lrm/coforge-sdk/internal";

const logger = getLogger(["coforge", "daemon", "reminder"]);
const RETRY_CAP_MS = 5 * 60_000;

export type ReminderAcknowledgementSyncRequest = {
  agentId: string;
  reminderId: string;
  version: number;
  operation: "ack" | "dismiss";
  idempotencyKey: string;
};

export function reminderAcknowledgementRequest(
  receipt: { agentId: string; reminderId: string; version: number },
  operation: "ack" | "dismiss",
): ReminderAcknowledgementSyncRequest {
  return {
    ...receipt,
    operation,
    idempotencyKey: reminderAcknowledgementIdempotencyKey(
      operation,
      receipt.reminderId,
      receipt.version,
    ),
  };
}

/** Best-effort cloud accounting for a local acknowledgement. The server's deterministic key makes
 * every retry and every restart harmless, so this queue needs no second durable receipt format. */
export class ReminderAcknowledgementSync {
  readonly #pending = new Map<string, number>();

  constructor(
    private readonly send: (request: ReminderAcknowledgementSyncRequest) => Promise<void>,
    private readonly schedule: (callback: () => void, delayMs: number) => void = (
      callback,
      delayMs,
    ) => {
      const timer = setTimeout(callback, delayMs);
      timer.unref?.();
    },
  ) {}

  enqueue(request: ReminderAcknowledgementSyncRequest): void {
    const key = `${request.agentId}:${request.reminderId}:${request.version}:${request.operation}`;
    if (this.#pending.has(key)) return;
    this.#pending.set(key, 0);
    void this.#attempt(key, request);
  }

  async #attempt(key: string, request: ReminderAcknowledgementSyncRequest): Promise<void> {
    try {
      await this.send(request);
      this.#pending.delete(key);
    } catch (error) {
      const attempt = (this.#pending.get(key) ?? 0) + 1;
      this.#pending.set(key, attempt);
      const delayMs = Math.min(RETRY_CAP_MS, 10_000 * 2 ** Math.min(attempt - 1, 5));
      logger.warn("Reminder acknowledgement sync failed; retrying", {
        error,
        event: "reminder.ack_sync_failed",
        outcome: "retrying",
        agent_id: request.agentId,
        reminder_id: request.reminderId,
        reminder_version: request.version,
        attempt,
      });
      this.schedule(() => void this.#attempt(key, request), delayMs);
    }
  }
}
