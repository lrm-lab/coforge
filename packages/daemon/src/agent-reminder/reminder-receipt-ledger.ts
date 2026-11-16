import { getLogger } from "@logtape/logtape";
import type { ReminderClock } from "./reminder-clock";
import { receiptKey, type ReminderReceipt, type ReminderReceiptStore } from "./reminder-receipt";

const logger = getLogger(["coforge", "daemon", "reminder"]);

/** Consumed receipts stay this long past their retry deadline as a re-fire fence, then go. */
const RECEIPT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** The durable fire receipts and this daemon's own copy of them, kept in step. */
export class ReminderReceiptLedger {
  readonly #receipts = new Map<string, ReminderReceipt>();

  constructor(
    private readonly store: ReminderReceiptStore,
    private readonly clock: ReminderClock,
  ) {}

  known(key: string): ReminderReceipt | undefined {
    return this.#receipts.get(key);
  }

  remember(key: string, receipt: ReminderReceipt): void {
    this.#receipts.set(key, receipt);
  }

  forget(key: string): void {
    this.#receipts.delete(key);
  }

  read(agentId: string): Promise<ReminderReceipt[]> {
    return this.store.read(agentId);
  }

  write(agentId: string, receipts: readonly ReminderReceipt[]): Promise<void> {
    return this.store.write(agentId, this.#retained(receipts));
  }

  async fresh(key: string, agentId: string): Promise<ReminderReceipt | undefined> {
    try {
      const disk = (await this.store.read(agentId)).find(
        (r) => receiptKey(agentId, r.reminderId, r.version) === key,
      );
      if (disk) this.#receipts.set(key, disk);
    } catch (error) {
      logger.error("Reminder receipt read failed", { error, agent_id: agentId });
    }
    return this.#receipts.get(key);
  }

  async saveMerged(receipt: ReminderReceipt): Promise<ReminderReceipt> {
    const receipts = await this.store.read(receipt.agentId);
    const index = receipts.findIndex(
      (r) => r.reminderId === receipt.reminderId && r.version === receipt.version,
    );
    const existing = index < 0 ? undefined : receipts[index];
    const merged = structuredClone(receipt);
    if (existing?.consumed) {
      merged.consumed = true;
      merged.terminal = true;
      // The Agent acknowledged it, so it was delivered, whatever this copy's retries concluded.
      delete merged.retryExhausted;
    }
    if (index < 0) receipts.push(merged);
    else receipts[index] = merged;
    await this.store.write(receipt.agentId, this.#retained(receipts));
    return merged;
  }

  /** Drops consumed receipts whose re-fire fence has expired so the file stays bounded. */
  #retained(receipts: readonly ReminderReceipt[]): ReminderReceipt[] {
    const cutoff = this.clock.now() - RECEIPT_RETENTION_MS;
    return receipts.filter((item) => !(item.consumed && item.terminal && item.deadline < cutoff));
  }

  async deleteReceipt(receipt: ReminderReceipt): Promise<boolean> {
    const key = receiptKey(receipt.agentId, receipt.reminderId, receipt.version);
    try {
      const receipts = (await this.store.read(receipt.agentId)).filter(
        (item) => item.reminderId !== receipt.reminderId || item.version !== receipt.version,
      );
      await this.store.write(receipt.agentId, receipts);
      this.#receipts.delete(key);
      return true;
    } catch (error) {
      logger.error("Premature reminder receipt deletion failed", {
        error,
        agent_id: receipt.agentId,
      });
      return false;
    }
  }
}
