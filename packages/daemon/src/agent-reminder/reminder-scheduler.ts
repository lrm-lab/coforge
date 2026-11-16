import { getLogger } from "@logtape/logtape";
import { defaultClock, type ReminderClock } from "./reminder-clock";
export { defaultClock, type ReminderClock } from "./reminder-clock";

import { ReminderJobMirror } from "./reminder-job-mirror";
import {
  logExhausted,
  logFireFailed,
  logWakeFailed,
  receiptKey,
  RETRY_EXHAUSTED_CODE,
  type ReminderReceipt,
  type ReminderReceiptStore,
  type ReminderRetryStage,
} from "./reminder-receipt";
import { ReminderReceiptLedger } from "./reminder-receipt-ledger";
import { MAX_ATTEMPTS, RETRY_BUDGET_MS, retryBackoff } from "./reminder-retry-policy";
import { ReminderTimers } from "./reminder-timers";
import { ReminderWork } from "./reminder-work";
import { assertCorrelated, assertSyncScope } from "./reminder-wire-checks";
import type {
  ReminderFireRequest,
  ReminderFireResponse,
  ReminderJob,
  ReminderSync,
} from "@lrm/coforge-sdk/internal";

const logger = getLogger(["coforge", "daemon", "reminder"]);
/** How far past its due time a wake has to reach the Agent before the reminder is called late. */
const LATE_AFTER_MS = 60_000;

/** Authenticated authoritative reminder mirror and durable fire state machine. */
export class ReminderScheduler {
  readonly #mirror = new ReminderJobMirror();
  readonly #ledger: ReminderReceiptLedger;
  readonly #scheduleTimers: ReminderTimers;
  readonly #receiptTimers: ReminderTimers;
  readonly #inFlight = new Set<string>();
  readonly #work = new ReminderWork();
  readonly #persistenceFailures = new Map<string, number>();
  /** The most recent fire or wake failure per receipt, reported when its retries run out. */
  readonly #lastFailures = new Map<string, unknown>();
  #generation = 0;
  #running = true;

  constructor(
    private readonly scope: { workspaceId: string; computerId: string },
    store: ReminderReceiptStore,
    private readonly fire: (request: ReminderFireRequest) => Promise<ReminderFireResponse>,
    private readonly wake: (job: ReminderJob, occurrence: { late: boolean }) => Promise<boolean>,
    private readonly clock: ReminderClock = defaultClock,
  ) {
    this.#ledger = new ReminderReceiptLedger(store, clock);
    this.#scheduleTimers = new ReminderTimers(clock, () => this.#running);
    this.#receiptTimers = new ReminderTimers(clock, () => this.#running);
  }

  apply(sync: ReminderSync): Promise<void> {
    return this.#work.serial(sync.agentId, async () => {
      if (!this.#running) throw new Error("reminder scheduler is stopped");
      assertSyncScope(this.scope, sync);
      if (sync.operation === "snapshot") {
        this.#scheduleTimers.cancelWithPrefix(`${sync.agentId}:`);
        this.#mirror.replaceWithSnapshot(sync);
        this.#armSchedules(sync.agentId);
        await this.#restore(sync.agentId);
        return;
      }
      const change = this.#mirror.applyChange(sync);
      if (!change) return;
      this.#cancelSchedule(sync.agentId, change.reminderId);
      if (change.job) this.#armSchedule(change.job);
    });
  }

  /**
   * Acknowledges one exact revision the Agent was woken for. A receipt missing from the store, or
   * a store that cannot be read, falls back to this daemon's own copy of the receipt; only a
   * revision neither knows as delivered answers false. A failed write still fails.
   */
  acknowledge(agentId: string, reminderId: string, version: number): Promise<boolean> {
    return this.#work.serial(agentId, async () => {
      const key = this.#receiptKey(agentId, reminderId, version);
      let receipts: ReminderReceipt[] | undefined;
      try {
        receipts = await this.#ledger.read(agentId);
      } catch (error) {
        logger.warn("Reminder receipts could not be read for an acknowledgement", {
          error,
          event: "reminder.ack_receipt_unreadable",
          outcome: "failed",
          agent_id: agentId,
          reminder_id: reminderId,
          reminder_version: version,
        });
      }
      const stored = receipts?.find((r) => r.reminderId === reminderId && r.version === version);
      const known = this.#ledger.known(key);
      const receipt = stored ?? (known && structuredClone(known));
      if (!receipt || receipt.serverResult !== "accepted" || !receipt.serverFired) return false;
      receipt.consumed = true;
      receipt.terminal = true;
      if (receipts) {
        if (!stored) receipts.push(receipt);
        await this.#ledger.write(agentId, receipts);
      }
      this.#ledger.remember(key, receipt);
      this.#cancelReceipt(agentId, reminderId, version);
      return true;
    });
  }

  awaitIdle(): Promise<void> {
    return this.#work.awaitIdle();
  }

  stop(): void {
    this.#running = false;
    this.#generation++;
    this.#scheduleTimers.cancelAll();
    this.#receiptTimers.cancelAll();
    this.#lastFailures.clear();
    this.#mirror.clear();
  }

  async #restore(agentId: string): Promise<void> {
    let receipts: ReminderReceipt[];
    try {
      receipts = await this.#ledger.read(agentId);
    } catch (error) {
      logger.error("Reminder receipt restore failed", {
        error,
        event: "reminder.receipt_restore_failed",
        outcome: "failed",
        agent_id: agentId,
      });
      return;
    }
    for (const receipt of receipts) {
      if (
        receipt.workspaceId !== this.scope.workspaceId ||
        receipt.computerId !== this.scope.computerId ||
        receipt.agentId !== agentId
      ) {
        logger.error("Reminder receipt restore rejected for another daemon", {
          event: "reminder.receipt_restore_rejected",
          outcome: "rejected",
          agent_id: agentId,
        });
        continue;
      }
      const key = this.#receiptKey(agentId, receipt.reminderId, receipt.version);
      this.#ledger.remember(key, receipt);
      if (!receipt.consumed && !receipt.terminal) this.#armReceipt(receipt, receipt.nextAt);
    }
  }

  #armSchedules(agentId: string): void {
    for (const job of this.#mirror.forAgent(agentId)) this.#armSchedule(job);
  }

  #armSchedule(job: ReminderJob): void {
    if (!this.#running) return;
    const key = this.#scheduleKey(job.ownerAgentId, job.reminderId);
    const due = Date.parse(job.fireAt);
    this.#scheduleTimers.arm(key, due, () => {
      const current = this.#mirror.get(job.ownerAgentId, job.reminderId);
      if (current?.version !== job.version) return;
      if (this.clock.now() < due) return this.#armSchedule(current);
      this.#work.track(this.#work.serial(job.ownerAgentId, () => this.#prepareDue(job)));
    });
  }

  async #prepareDue(job: ReminderJob): Promise<void> {
    if (
      !this.#running ||
      this.#mirror.get(job.ownerAgentId, job.reminderId)?.version !== job.version
    )
      return;
    const key = this.#receiptKey(job.ownerAgentId, job.reminderId, job.version);
    let receipt = this.#ledger.known(key);
    if (!receipt) {
      try {
        receipt = (await this.#ledger.read(job.ownerAgentId)).find(
          (r) => r.reminderId === job.reminderId && r.version === job.version,
        );
      } catch (error) {
        logger.error("Reminder receipt read failed", {
          error,
          event: "reminder.receipt_read_failed",
          outcome: "failed",
          agent_id: job.ownerAgentId,
        });
      }
    }
    if (!receipt) {
      const now = this.clock.now();
      receipt = {
        ...this.scope,
        agentId: job.ownerAgentId,
        reminderId: job.reminderId,
        version: job.version,
        job: structuredClone(job),
        requestId: crypto.randomUUID(),
        firedAtClient: new Date(now).toISOString(),
        attempt: 0,
        deadline: now + RETRY_BUDGET_MS,
        nextAt: now,
        wakeAccepted: false,
        consumed: false,
        terminal: false,
      };
    }
    this.#ledger.remember(key, receipt);
    await this.#persistOrRetry(receipt, true);
  }

  async #persistOrRetry(
    receipt: ReminderReceipt,
    proceed: boolean | "retry",
    afterFailure: boolean | "retry" = proceed,
  ): Promise<boolean> {
    const key = this.#receiptKey(receipt.agentId, receipt.reminderId, receipt.version);
    try {
      const current = await this.#ledger.saveMerged(receipt);
      this.#ledger.remember(key, current);
      this.#persistenceFailures.delete(key);
      if (proceed === true && !current.consumed && !current.terminal) this.#startEffect(current);
      else if (proceed === "retry" && !current.consumed && !current.terminal) this.#retry(current);
      return !current.consumed && !current.terminal;
    } catch (error) {
      const failures = (this.#persistenceFailures.get(key) ?? 0) + 1;
      this.#persistenceFailures.set(key, failures);
      logger.error("Reminder receipt persistence failed", {
        error,
        event: "reminder.receipt_persist_failed",
        outcome: "failed",
        agent_id: receipt.agentId,
      });
      if (!this.#running) return false;
      if (failures >= MAX_ATTEMPTS || this.clock.now() >= receipt.deadline) {
        // The store is what keeps failing, so this outcome can only be logged, not recorded.
        logExhausted(receipt, "persistence", error, failures);
        return false;
      }
      receipt.nextAt = Math.min(receipt.deadline, this.clock.now() + retryBackoff(failures));
      this.#armReceipt(receipt, receipt.nextAt, false, afterFailure);
      return false;
    }
  }

  #startEffect(receipt: ReminderReceipt): void {
    const key = this.#receiptKey(receipt.agentId, receipt.reminderId, receipt.version);
    if (!this.#running || this.#inFlight.has(key)) return;
    if (receipt.attempt >= MAX_ATTEMPTS || this.clock.now() >= receipt.deadline) {
      this.#exhaust(receipt);
      return;
    }
    receipt.attempt++;
    this.#lastFailures.delete(key);
    this.#inFlight.add(key);
    const generation = this.#generation;
    let readyToWake = false;
    this.#work.track(
      this.#work
        .serial(receipt.agentId, async () => {
          const current = this.#ledger.known(key);
          return current ? this.#persistOrRetry(current, false, true) : false;
        })
        .then(async (persisted) => {
          if (!persisted) return;
          if (!this.#running || generation !== this.#generation) return;
          const current = this.#ledger.known(key);
          if (!current || current.consumed || current.terminal) return;
          if (current.serverResult === "accepted" && current.serverFired)
            await this.#runWake(key, current, generation);
          else readyToWake = await this.#runFire(key, current, generation);
        })
        .finally(() => {
          this.#inFlight.delete(key);
          const current = this.#ledger.known(key);
          if (
            readyToWake &&
            this.#running &&
            current?.serverResult === "accepted" &&
            current.serverFired &&
            !current.consumed &&
            !current.terminal
          )
            this.#startEffect(current);
        }),
    );
  }

  async #runFire(key: string, receipt: ReminderReceipt, generation: number): Promise<boolean> {
    let response: ReminderFireResponse | undefined;
    try {
      const candidate = await this.fire({
        protocolMajor: 1,
        requestId: receipt.requestId,
        workspaceId: receipt.workspaceId,
        computerId: receipt.computerId,
        agentId: receipt.agentId,
        reminderId: receipt.reminderId,
        version: receipt.version,
        firedAtClient: receipt.firedAtClient,
      });
      assertCorrelated(receipt, candidate);
      response = candidate;
    } catch (error) {
      this.#lastFailures.set(key, error);
      logFireFailed(receipt, error);
    }
    return this.#work.serial(receipt.agentId, async () => {
      if (!this.#running || generation !== this.#generation) return false;
      const current = await this.#ledger.fresh(key, receipt.agentId);
      if (!current || current.consumed || current.terminal) return false;
      if (!response) {
        this.#retry(current);
        return false;
      }
      current.serverResult = response.result;
      current.serverFired = response.fired;
      current.serverCatchup = response.catchup;
      if (response.result === "accepted" && response.fired)
        return this.#persistOrRetry(current, false, true);
      else if (response.result === "premature") {
        const retryAt = this.clock.now() + (response.retryAfterMs ?? 0);
        if (retryAt > current.deadline) {
          if (await this.#ledger.deleteReceipt(current)) this.#armServerRetry(current.job, retryAt);
        } else {
          current.nextAt = retryAt;
          await this.#persistOrRetry(current, false);
          this.#armReceipt(current, current.nextAt);
        }
      } else {
        current.terminal = true;
        await this.#persistOrRetry(current, false);
      }
      return false;
    });
  }

  async #runWake(key: string, receipt: ReminderReceipt, generation: number): Promise<void> {
    let accepted = false;
    try {
      // Measured here rather than taken from the cloud's `catchup`, which calls any fire after the
      // due instant a catch-up, including an on-time one that merely took a round trip.
      const late = this.clock.now() - Date.parse(receipt.job.fireAt) > LATE_AFTER_MS;
      accepted = await this.wake(receipt.job, { late });
    } catch (error) {
      this.#lastFailures.set(key, error);
      logWakeFailed(receipt, error);
    }
    await this.#work.serial(receipt.agentId, async () => {
      if (!this.#running || generation !== this.#generation) return;
      const current = await this.#ledger.fresh(key, receipt.agentId);
      if (!current || current.consumed || current.terminal) return;
      current.wakeAccepted = accepted;
      if (accepted) current.terminal = true;
      await this.#persistOrRetry(current, accepted ? false : "retry");
    });
  }

  #retry(receipt: ReminderReceipt): void {
    if (receipt.attempt >= MAX_ATTEMPTS || this.clock.now() >= receipt.deadline) {
      this.#exhaust(receipt);
      return;
    }
    receipt.nextAt = Math.min(receipt.deadline, this.clock.now() + retryBackoff(receipt.attempt));
    this.#armReceipt(receipt, receipt.nextAt);
  }

  /** Ends a receipt whose attempts or deadline ran out, recording and logging the step that failed. */
  #exhaust(receipt: ReminderReceipt): void {
    if (receipt.terminal) return;
    const key = this.#receiptKey(receipt.agentId, receipt.reminderId, receipt.version);
    // Once the cloud has accepted and fired, only the local wake remains to succeed.
    const stage: ReminderRetryStage =
      receipt.serverResult === "accepted" && receipt.serverFired ? "wake" : "fire";
    receipt.terminal = true;
    receipt.retryExhausted = {
      code: RETRY_EXHAUSTED_CODE,
      stage,
      attempts: receipt.attempt,
      deadline: receipt.deadline,
      exhaustedAt: this.clock.now(),
    };
    logExhausted(receipt, stage, this.#lastFailures.get(key));
    this.#lastFailures.delete(key);
    this.#work.track(
      this.#work.serial(receipt.agentId, () => this.#persistOrRetry(receipt, false)),
    );
  }

  #armReceipt(
    receipt: ReminderReceipt,
    at = receipt.nextAt,
    proceed = true,
    afterPersistence: boolean | "retry" = true,
  ): void {
    if (!this.#running || receipt.consumed || receipt.terminal) return;
    const key = this.#receiptKey(receipt.agentId, receipt.reminderId, receipt.version);
    const nextAt = Math.min(receipt.deadline, at);
    receipt.nextAt = nextAt;
    this.#receiptTimers.arm(key, nextAt, () => {
      if (this.clock.now() < receipt.nextAt)
        return this.#armReceipt(receipt, receipt.nextAt, proceed, afterPersistence);
      this.#work.track(
        this.#work.serial(receipt.agentId, async () => {
          const current = proceed
            ? await this.#ledger.fresh(key, receipt.agentId)
            : this.#ledger.known(key);
          if (!current || current.consumed || current.terminal) return;
          if (proceed) this.#startEffect(current);
          else await this.#persistOrRetry(current, afterPersistence);
        }),
      );
    });
  }

  #armServerRetry(job: ReminderJob, retryAt: number): void {
    // Reached after a receipt delete that may have been under way when `stop()` cleared the timers.
    if (!this.#running) return;
    const key = this.#scheduleKey(job.ownerAgentId, job.reminderId);
    this.#scheduleTimers.arm(key, retryAt, () => {
      const current = this.#mirror.get(job.ownerAgentId, job.reminderId);
      if (current?.version !== job.version) return;
      this.#work.track(this.#work.serial(job.ownerAgentId, () => this.#prepareDue(current)));
    });
  }

  #cancelSchedule(agentId: string, reminderId: string) {
    this.#scheduleTimers.cancel(this.#scheduleKey(agentId, reminderId));
  }
  #cancelReceipt(agentId: string, reminderId: string, version: number) {
    this.#receiptTimers.cancel(this.#receiptKey(agentId, reminderId, version));
  }
  #scheduleKey(agentId: string, reminderId: string) {
    return `${agentId}:${reminderId}`;
  }
  #receiptKey(agentId: string, reminderId: string, version: number) {
    return receiptKey(agentId, reminderId, version);
  }
}
