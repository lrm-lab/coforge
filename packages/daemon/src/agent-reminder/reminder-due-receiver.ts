import { getLogger } from "@logtape/logtape";
import type { ReminderDue, ReminderDueAckRequest, ReminderJob } from "@lrm/coforge-sdk/internal";
import {
  reminderDueExpired,
  type ReminderDueRecord,
  type ReminderDueRecordState,
  type ReminderDueStore,
} from "./reminder-due-record";
import {
  reminderAcknowledgementRequest,
  type ReminderAcknowledgementSyncRequest,
} from "./reminder-acknowledgement-sync";
import { ReminderWork } from "./reminder-work";

const logger = getLogger(["coforge", "daemon", "reminder"]);
const LATE_AFTER_MS = 60_000;

export type ReminderDuePorts = Readonly<{
  acknowledge(request: ReminderDueAckRequest): Promise<boolean>;
  deliver(job: ReminderJob, occurrence: { late: boolean }): Promise<unknown>;
  acknowledgeCloud?(request: ReminderAcknowledgementSyncRequest): void;
  now?(): number;
}>;

export class ReminderDueReceiver {
  readonly #work = new ReminderWork();
  #running = true;

  constructor(
    private readonly scope: { workspaceId: string; computerId: string },
    private readonly store: ReminderDueStore,
    private readonly ports: ReminderDuePorts,
  ) {}

  receive(due: ReminderDue): Promise<void> {
    return this.#work.serial(due.agentId, async () => {
      if (!this.#running) return;
      if (due.workspaceId !== this.scope.workspaceId || due.computerId !== this.scope.computerId) {
        this.#log("warn", "reminder.due_rejected", due, { reason: "scope" });
        return;
      }
      const records = await this.#records(due.agentId);
      const known = records.find((record) => record.due.occurrenceId === due.occurrenceId);
      if (known?.state === "delivered") {
        this.#log("info", "reminder.due_duplicate", due, { state: known.state });
        await this.#acknowledge(due);
        return;
      }
      if (known?.state === "refused") return;
      if (!known && reminderDueExpired(due, this.#now())) {
        this.#log("warn", "reminder.due_expired_locally", due);
        return;
      }
      const record = known ?? { state: "received" as const, due };
      if (!known) {
        records.push(record);
        await this.#save(due.agentId, records);
      }
      await this.#advance(due.agentId, records, record);
    });
  }

  restore(): Promise<void> {
    return this.#work
      .serial("", async () => {
        const agents = await this.store.agents();
        await Promise.all(agents.map((agentId) => this.#restoreAgent(agentId)));
      })
      .catch((error: unknown) => {
        logger.error("Reminder due records could not be restored", {
          error,
          event: "reminder.due_restore_failed",
          outcome: "failed",
        });
      });
  }

  acknowledge(
    agentId: string,
    reminderId: string,
    version: number,
    operation: "ack" | "dismiss" = "ack",
  ): Promise<boolean> {
    return this.#work.serial(agentId, async () => {
      let records: ReminderDueRecord[];
      try {
        records = await this.#records(agentId);
      } catch (error) {
        logger.warn("reminder.due_records_unreadable", {
          event: "reminder.due_records_unreadable",
          agent_id: agentId,
          error,
        });
        return false;
      }
      const delivered = records.some(
        (record) =>
          record.state === "delivered" &&
          record.due.job.reminderId === reminderId &&
          record.due.job.version === version,
      );
      if (delivered)
        this.ports.acknowledgeCloud?.(
          reminderAcknowledgementRequest({ agentId, reminderId, version }, operation),
        );
      return delivered;
    });
  }

  stop(): void {
    this.#running = false;
  }

  awaitIdle(): Promise<void> {
    return this.#work.awaitIdle();
  }

  #restoreAgent(agentId: string): Promise<void> {
    return this.#work.serial(agentId, async () => {
      const records = await this.#records(agentId);
      for (const record of records)
        if (record.state === "received" || record.state === "acknowledged")
          await this.#advance(agentId, records, record);
    });
  }

  async #advance(
    agentId: string,
    records: ReminderDueRecord[],
    record: ReminderDueRecord,
  ): Promise<void> {
    if (!this.#running) return;
    if (record.state === "received") {
      const accepted = await this.#acknowledge(record.due);
      if (accepted === undefined) return;
      await this.#transition(agentId, records, record, accepted ? "acknowledged" : "refused");
      if (!accepted) {
        this.#log("warn", "reminder.due_refused", record.due);
        return;
      }
    }
    if (!this.#running || record.state !== "acknowledged") return;
    const late = this.#now() - Date.parse(record.due.job.fireAt) > LATE_AFTER_MS;
    await this.ports.deliver(record.due.job, { late });
    await this.#transition(agentId, records, record, "delivered");
    this.#log("info", "reminder.due_delivered", record.due, { late });
  }

  async #acknowledge(due: ReminderDue): Promise<boolean | undefined> {
    try {
      return await this.ports.acknowledge({
        protocolMajor: 1,
        requestId: crypto.randomUUID(),
        workspaceId: due.workspaceId,
        computerId: due.computerId,
        agentId: due.agentId,
        occurrenceId: due.occurrenceId,
        reminderId: due.job.reminderId,
        version: due.job.version,
      });
    } catch (error) {
      this.#log("warn", "reminder.due_ack_failed", due, { error });
      return undefined;
    }
  }

  async #transition(
    agentId: string,
    records: ReminderDueRecord[],
    record: ReminderDueRecord,
    state: ReminderDueRecordState,
  ): Promise<void> {
    record.state = state;
    await this.#save(agentId, records);
  }

  async #records(agentId: string): Promise<ReminderDueRecord[]> {
    return this.#live(await this.store.read(agentId));
  }

  async #save(agentId: string, records: ReminderDueRecord[]): Promise<void> {
    await this.store.write(agentId, this.#live(records));
  }

  #live(records: readonly ReminderDueRecord[]): ReminderDueRecord[] {
    const now = this.#now();
    return records.filter(
      (record) => record.state === "acknowledged" || !reminderDueExpired(record.due, now),
    );
  }

  #now(): number {
    return this.ports.now?.() ?? Date.now();
  }

  #log(
    level: "info" | "warn",
    event: string,
    due: ReminderDue,
    extra: Record<string, unknown> = {},
  ): void {
    logger[level](event, {
      event,
      agent_id: due.agentId,
      occurrence_id: due.occurrenceId,
      reminder_id: due.job.reminderId,
      reminder_version: due.job.version,
      ...extra,
    });
  }
}
