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
import { defaultClock, type ReminderClock } from "./reminder-clock";
import { ReminderRetries, settle } from "./reminder-retries";

const logger = getLogger(["coforge", "daemon", "reminder"]);
const LATE_AFTER_MS = 60_000;

export type ReminderDuePorts = Readonly<{
  acknowledge(request: ReminderDueAckRequest): Promise<boolean>;
  deliver(job: ReminderJob, occurrence: { late: boolean }): Promise<string>;
  wake(agentId: string, itemId: string): Promise<boolean>;
  acknowledgeCloud?(request: ReminderAcknowledgementSyncRequest): void;
  clock?: ReminderClock;
}>;

export class ReminderDueReceiver {
  readonly #work = new ReminderWork();
  readonly #retries: ReminderRetries;
  #running = true;

  constructor(
    private readonly scope: { workspaceId: string; computerId: string },
    private readonly store: ReminderDueStore,
    private readonly ports: ReminderDuePorts,
  ) {
    this.#retries = new ReminderRetries(this.#clock());
  }

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
      try {
        await this.#advance(due.agentId, records, record);
      } catch (error) {
        this.#log("warn", "reminder.due_delivery_failed", due, { error });
        this.#retryRestore(due.agentId);
      }
    });
  }

  restore(): Promise<void> {
    return this.#work
      .serial("", async () => {
        const agents = await this.store.agents();
        await Promise.all(
          agents.map((agentId) =>
            this.#restoreAgent(agentId).catch((error: unknown) => {
              logger.error("Reminder due records of one Agent could not be restored", {
                error,
                event: "reminder.due_restore_failed",
                agent_id: agentId,
                outcome: "failed",
              });
              this.#retryRestore(agentId);
            }),
          ),
        );
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
    this.#retries.stop();
  }

  awaitIdle(): Promise<void> {
    return this.#work.awaitIdle();
  }

  #restoreAgent(agentId: string): Promise<void> {
    return this.#work.serial(agentId, () => this.#advanceAll(agentId));
  }

  /** A delivery that ran while no wake followed it — the daemon stopped, or the launch was
   * cancelled — is woken again here, and `wake` settles one whose item is already gone. */
  async #advanceAll(agentId: string): Promise<void> {
    const records = await this.#records(agentId);
    for (const record of records) {
      if (record.state === "received" || record.state === "acknowledged")
        await this.#advance(agentId, records, record);
      else if (record.state === "delivered" && record.wokenAtMs === undefined)
        this.#wake(agentId, record);
    }
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
    const itemId = await this.ports.deliver(record.due.job, { late });
    record.itemId = itemId;
    await this.#transition(agentId, records, record, "delivered");
    this.#log("info", "reminder.due_delivered", record.due, { late });
    this.#wake(agentId, record);
  }

  #wake(agentId: string, record: ReminderDueRecord): void {
    if (record.itemId === undefined || record.wokenAtMs !== undefined) return;
    const itemId = record.itemId;
    const key = `wake:${agentId}:${itemId}`;
    const attempt = async () => {
      if (!this.#running) return false;
      const woken = await this.ports.wake(agentId, itemId).catch(() => false);
      if (woken) await this.#markWoken(agentId, record);
      return woken;
    };
    void settle(attempt).then((done) => {
      // A runtime on its way out leaves the wake to the restore that follows, not to a retry.
      if (!this.#running || done) return;
      this.#log("warn", "reminder.due_wake_failed", record.due, { item_id: itemId });
      this.#retries.later(key, attempt, () =>
        this.#log("warn", "reminder.due_wake_abandoned", record.due, { item_id: itemId }),
      );
    });
  }

  /** Records the wake that reached the Agent, so no later restore wakes it a second time. */
  async #markWoken(agentId: string, record: ReminderDueRecord): Promise<void> {
    await this.#work.serial(agentId, async () => {
      const fresh = await this.#records(agentId);
      const target = fresh.find((entry) => entry.due.occurrenceId === record.due.occurrenceId);
      if (!target || target.wokenAtMs !== undefined) return;
      target.wokenAtMs = this.#now();
      await this.#save(agentId, fresh);
    });
  }

  #retryRestore(agentId: string): void {
    const attempt = () =>
      this.#running
        ? this.#work.serial(agentId, () => this.#advanceAll(agentId)).then(() => true)
        : Promise.resolve(true);
    this.#retries.later(`restore:${agentId}`, attempt, () =>
      logger.error("Reminder due delivery kept failing; the next restore tries again", {
        event: "reminder.due_delivery_abandoned",
        agent_id: agentId,
      }),
    );
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
    return this.#clock().now();
  }

  #clock(): ReminderClock {
    return this.ports.clock ?? defaultClock;
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
