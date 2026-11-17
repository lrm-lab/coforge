import type { ReminderDue, ReminderDueAckRequest } from "@lrm/coforge-sdk/internal";

export const REMINDER_DUE_INTERVAL_MS = 5_000;
export const REMINDER_DUE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export type ReminderComputerScope = { workspaceId: string; computerId: string };

export interface ReminderDueStore {
  claim(now: Date): Promise<void>;
  expire(now: Date): Promise<ReminderDue[]>;
  pending(now: Date, scope?: ReminderComputerScope): Promise<ReminderDue[]>;
  acknowledge(request: ReminderDueAckRequest, now: Date): Promise<boolean>;
}

export class ReminderDueWorker {
  constructor(
    private readonly store: ReminderDueStore,
    private readonly publish: (
      dues: readonly ReminderDue[],
    ) => Promise<PromiseSettledResult<unknown>[]>,
  ) {}

  async tick(now: Date): Promise<void> {
    await this.expire(now);
    await this.store.claim(now);
    await this.expire(now);
    await this.deliver(await this.store.pending(now), false, now);
  }

  private async expire(now: Date): Promise<void> {
    for (const due of await this.store.expire(now)) {
      console.error(
        JSON.stringify({
          event: "reminder.due_expired",
          occurrence_id: due.occurrenceId,
          reminder_id: due.job.reminderId,
          revision: due.job.version,
          delay_ms: now.getTime() - Date.parse(due.job.fireAt),
          deduplicated: false,
        }),
      );
    }
  }

  async replay(scope: ReminderComputerScope, now: Date): Promise<void> {
    await this.deliver(await this.store.pending(now, scope), true, now);
  }

  acknowledge(request: ReminderDueAckRequest, now: Date): Promise<boolean> {
    return this.store.acknowledge(request, now);
  }

  private async deliver(occurrences: ReminderDue[], replay: boolean, now: Date): Promise<void> {
    if (!occurrences.length) return;
    let results: PromiseSettledResult<unknown>[];
    try {
      results = await this.publish(occurrences);
    } catch (reason) {
      results = occurrences.map(() => ({ status: "rejected" as const, reason }));
    }
    for (const [index, due] of occurrences.entries()) {
      if (results[index]?.status === "fulfilled") {
        console.info(
          JSON.stringify({
            event: replay ? "reminder.due_replayed" : "reminder.due_published",
            occurrence_id: due.occurrenceId,
            reminder_id: due.job.reminderId,
            revision: due.job.version,
            delay_ms: now.getTime() - Date.parse(due.job.fireAt),
            deduplicated: replay,
          }),
        );
      } else {
        console.warn(
          JSON.stringify({
            event: "reminder.due_publish_failed",
            occurrence_id: due.occurrenceId,
          }),
        );
      }
    }
  }
}
