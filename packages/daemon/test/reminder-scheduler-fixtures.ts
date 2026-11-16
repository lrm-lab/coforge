import type { LogRecord } from "@logtape/logtape";
import type { ReminderJob, ReminderSync } from "@lrm/coforge-sdk/internal";
import type { ReminderReceipt, ReminderReceiptStore } from "#src/agent-reminder/reminder-scheduler";
import type { ReminderClock } from "#src/agent-reminder/reminder-scheduler";

export class MemoryStore implements ReminderReceiptStore {
  receipts: ReminderReceipt[] = [];
  async read() {
    return structuredClone(this.receipts);
  }
  async write(_agentId: string, receipts: readonly ReminderReceipt[]) {
    this.receipts = structuredClone([...receipts]);
  }
}

/** A store whose writes can be held from the moment a test asks, so the scheduler can be stopped
 * while one is under way. */
export class HoldableStore extends MemoryStore {
  holding = false;
  writes = 0;
  readonly started = Promise.withResolvers<void>();
  readonly release = Promise.withResolvers<void>();
  override async write(agentId: string, receipts: readonly ReminderReceipt[]) {
    if (this.holding) {
      this.holding = false;
      this.started.resolve();
      await this.release.promise;
    }
    await super.write(agentId, receipts);
    this.writes++;
  }
}

export class Clock implements ReminderClock {
  time = Date.parse("2026-09-08T12:00:00Z");
  timers: Array<{ at: number; callback: () => void }> = [];
  now = () => this.time;
  schedule(callback: () => void, delayMs: number) {
    const timer = { at: this.time + delayMs, callback };
    this.timers.push(timer);
    return timer;
  }
  cancel(timer: unknown) {
    this.timers = this.timers.filter((item) => item !== timer);
  }
  async advance(ms: number) {
    this.time += ms;
    const due = this.timers.filter((timer) => timer.at <= this.time);
    this.timers = this.timers.filter((timer) => timer.at > this.time);
    for (const timer of due) timer.callback();
    await Promise.all(due.map(async () => {}));
  }
}

export const exhaustedLogs = (records: LogRecord[]) =>
  records.filter((record) => record.properties.event === "reminder.retry_exhausted");

export const job: ReminderJob = {
  reminderId: "123e4567-e89b-42d3-a456-426614174000",
  ownerAgentId: "agent-a",
  version: 3,
  title: "Review",
  target: "@frank",
  messageId: "123e4567-e89b-42d3-a456-426614174001",
  fireAt: "2026-09-08T12:00:01Z",
};
export const snapshot = (jobs: ReminderJob[]): ReminderSync => ({
  protocolMajor: 1,
  requestId: crypto.randomUUID(),
  workspaceId: "workspace-a",
  computerId: "computer-a",
  agentId: "agent-a",
  operation: "snapshot",
  jobs,
  messageType: "coforge.rpc.v1.ReminderSync",
});
export const change = (operation: "upsert" | "cancel", version: number): ReminderSync => ({
  ...snapshot([]),
  operation,
  jobs: operation === "upsert" ? [{ ...job, version }] : [],
  reminderId: operation === "cancel" ? job.reminderId : undefined,
  version: operation === "cancel" ? version : undefined,
});
