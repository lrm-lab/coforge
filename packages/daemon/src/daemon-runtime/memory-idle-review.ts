import type { AgentMessageDelivery } from "@lrm/coforge-sdk/internal";
import { deliveryImportance, DELIVERY_IMPORTANCE } from "./delivery-importance";
import { getLogger } from "@logtape/logtape";
import type { MemoryReviewLedger } from "#src/persistence/memory-review-ledger";
import {
  memoryReviewPrompt,
  type MemoryReviewReceipt,
} from "#src/local-memory/memory-review-receipt";
import { scheduleUnrefTimer, type UnrefTimerSchedule } from "./unref-timer";

export const MEMORY_REVIEW_INTERVAL_MS = 24 * 60 * 60_000;
const IDLE_CHECK_MS = 60_000;
const logger = getLogger(["coforge", "daemon", "memory-review"]);
export type MemoryIdleReviewPorts = {
  ledger(agentId: string): MemoryReviewLedger;
  idle(agentId: string): boolean;
  deliver(agentId: string, text: string): Promise<boolean>;
  receipt(agentId: string): Promise<MemoryReviewReceipt | undefined>;
  now?(): number;
  schedule?: UnrefTimerSchedule;
};

export function humanMemoryActivityTime(
  message: Pick<
    AgentMessageDelivery,
    | "latestSenderKind"
    | "createdAtMs"
    | "source"
    | "target"
    | "reason"
    | "mentionsAgent"
    | "nonMemberMention"
    | "taskDiscussion"
  >,
): number | undefined {
  return message.latestSenderKind === "human" &&
    message.source !== "app" &&
    deliveryImportance(message) === DELIVERY_IMPORTANCE.RELIABLE
    ? message.createdAtMs
    : undefined;
}

export class MemoryIdleReview {
  readonly #timers = new Map<string, () => void>();
  readonly #inspecting = new Set<string>();
  readonly #epochs = new Map<string, object>();
  constructor(private readonly ports: MemoryIdleReviewPorts) {}

  noteHuman(agentId: string, createdAt: number): void {
    this.#safe(agentId, () => this.ports.ledger(agentId).noteHuman(createdAt));
    this.onIdle(agentId);
  }

  noteWrite(agentId: string, key: string, revision: string): void {
    this.#safe(agentId, () => this.ports.ledger(agentId).noteWrite(key, revision));
    this.onIdle(agentId);
  }

  onIdle(agentId: string): void {
    if (this.#timers.has(agentId)) return;
    if (!this.#epochs.has(agentId)) this.#epochs.set(agentId, {});
    const cancel = (this.ports.schedule ?? scheduleUnrefTimer)(async () => {
      this.#timers.delete(agentId);
      await this.inspect(agentId);
    }, IDLE_CHECK_MS);
    this.#timers.set(agentId, cancel);
  }

  async inspect(agentId: string): Promise<void> {
    if (this.#inspecting.has(agentId)) return;
    this.#inspecting.add(agentId);
    if (!this.#epochs.has(agentId)) this.#epochs.set(agentId, {});
    const epoch = this.#epochs.get(agentId);
    try {
      if (!this.ports.idle(agentId)) return;
      const ledger = this.ports.ledger(agentId);
      const prior = ledger.state();
      if (prior.active) {
        const receipt = await this.ports.receipt(agentId).catch((error: unknown) => {
          this.#logFailure(agentId, error);
          return undefined;
        });
        if (this.#epochs.get(agentId) !== epoch || !this.ports.idle(agentId)) return;
        ledger.finish(
          prior.active.id,
          receipt?.batchId === prior.active.id ? receipt.reviewed : [],
        );
      }
      const state = ledger.state();
      const now = this.ports.now?.() ?? Date.now();
      if (
        state.humanAt <= state.usedHumanAt ||
        (state.lastStartedAt > 0 && now - state.lastStartedAt < MEMORY_REVIEW_INTERVAL_MS)
      )
        return;
      const entries = ledger.pending();
      if (!entries.length || !this.ports.idle(agentId)) return;
      const batch = { id: crypto.randomUUID(), humanAt: state.humanAt, entries };
      ledger.save({ ...state, usedHumanAt: state.humanAt, lastStartedAt: now, active: batch });
      const delivered = await this.ports.deliver(agentId, memoryReviewPrompt(batch, now));
      if (this.#epochs.get(agentId) !== epoch) return;
      if (!delivered) {
        const current = ledger.state();
        ledger.save({ ...state, humanAt: current.humanAt });
      }
      logger.info("Personal memory review admission completed", {
        event: "memory_review:admission",
        agent_id: agentId,
        delivered,
        count: entries.length,
      });
    } catch (error) {
      this.#logFailure(agentId, error);
    } finally {
      this.#inspecting.delete(agentId);
      if (this.#epochs.get(agentId) === epoch) this.onIdle(agentId);
    }
  }

  forget(agentId: string): void {
    this.#timers.get(agentId)?.();
    this.#timers.delete(agentId);
    this.#epochs.delete(agentId);
  }

  clear(): void {
    for (const agentId of this.#epochs.keys()) this.forget(agentId);
  }

  #safe(agentId: string, run: () => void): void {
    try {
      run();
    } catch (error) {
      this.#logFailure(agentId, error);
    }
  }

  #logFailure(agentId: string, error: unknown): void {
    logger.warn("Personal memory review deferred", {
      event: "memory_review:failed",
      agent_id: agentId,
      error_code: error instanceof Error ? error.name : "unknown",
    });
  }
}
