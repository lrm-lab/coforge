import { getLogger } from "@logtape/logtape";
import type { AgentMessageDelivery } from "@lrm/coforge-sdk/internal";

const logger = getLogger(["coforge", "daemon", "runtime"]);

/** Backoff applied after the 2nd consecutive unproductive wake on the same delivery key. */
export const WAKE_LOOP_BACKOFF_MS = 60_000;
export const WAKE_LOOP_BACKOFF_STREAK = 2;
export const WAKE_LOOP_PARK_STREAK = 3;

export type WakeKeySource = Pick<
  AgentMessageDelivery,
  "messageId" | "deliveryId" | "target" | "sequence"
>;

/** Stable key for one or more deliveries waking an Agent: changes whenever a new message arrives. */
export function deliveryWakeKey(messages: readonly WakeKeySource[]): string | undefined {
  if (messages.length === 0) return undefined;
  const parts = new Set<string>();
  for (const message of messages) {
    const id =
      message.messageId ||
      message.deliveryId ||
      `${message.target ?? ""}:${String(message.sequence)}`;
    if (id) parts.add(id);
  }
  if (parts.size === 0) return undefined;
  return [...parts].sort().join(",");
}

export type WakeLoopAdmission =
  | { status: "allow" }
  | { status: "backoff"; untilMs: number; remainingMs: number }
  | { status: "parked" };

export type WakeLoopTurnOutcome = {
  action: "none" | "reset" | "armed" | "backoff" | "parked";
  streak: number;
  key?: string;
  backoffUntilMs?: number;
};

type StreakRecord = {
  key: string;
  streak: number;
  backoffUntilMs?: number;
  parked: boolean;
};

type ActiveWakeTurn = {
  key: string;
  toolCalls: number;
  coforgeActions: number;
};

export type WakeLoopGuardOptions = {
  now?: () => number;
  backoffMs?: number;
};

/**
 * Guards against unproductive wake loops where the same message/delivery key repeatedly wakes an
 * Agent and completes with `toolCalls === 0` and zero `coforge` message/task writes or freshness
 * holds:
 * - Streak 1: armed.
 * - Streak 2: 60s backoff before another wake on the same key is admitted.
 * - Streak 3: parks that key until a new delivery key arrives or real tool/`coforge` work happens.
 */
export class WakeLoopGuard {
  readonly #records = new Map<string, StreakRecord>();
  readonly #activeTurns = new Map<string, ActiveWakeTurn>();
  readonly #now: () => number;
  readonly #backoffMs: number;

  constructor(options: WakeLoopGuardOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#backoffMs = options.backoffMs ?? WAKE_LOOP_BACKOFF_MS;
  }

  /** Notes an inbound delivery key; returns `true` when a new key cleared an existing streak/hold. */
  noteDeliveryArrival(agentId: string, key: string): boolean {
    const record = this.#records.get(agentId);
    if (!record || record.key === key) return false;
    this.#records.delete(agentId);
    return true;
  }

  /** Decides whether a wake on `key` may proceed now, must wait out a 60s backoff, or is parked. */
  admitWake(agentId: string, key: string): WakeLoopAdmission {
    const record = this.#records.get(agentId);
    if (!record) return { status: "allow" };
    if (record.key !== key) {
      this.#records.delete(agentId);
      return { status: "allow" };
    }
    if (record.parked) return { status: "parked" };
    if (record.backoffUntilMs !== undefined) {
      const remainingMs = record.backoffUntilMs - this.#now();
      if (remainingMs > 0) {
        return { status: "backoff", untilMs: record.backoffUntilMs, remainingMs };
      }
      record.backoffUntilMs = undefined;
    }
    return { status: "allow" };
  }

  /** Marks a wake turn as running on `key`. */
  noteWakeStarted(agentId: string, key: string): void {
    const record = this.#records.get(agentId);
    if (record && record.key !== key) this.#records.delete(agentId);
    const existing = this.#activeTurns.get(agentId);
    if (existing && existing.key === key) return;
    this.#activeTurns.set(agentId, { key, toolCalls: 0, coforgeActions: 0 });
  }

  /** Records a tool execution during the active turn and clears any unproductive streak. */
  noteToolCall(agentId: string): void {
    const active = this.#activeTurns.get(agentId);
    if (active) active.toolCalls += 1;
    this.#records.delete(agentId);
  }

  /** Records a `coforge` message/task write or freshness hold and clears any unproductive streak. */
  noteCoforgeWriteOrHold(agentId: string): void {
    const active = this.#activeTurns.get(agentId);
    if (active) active.coforgeActions += 1;
    this.#records.delete(agentId);
  }

  /** Current backoff deadline for `agentId`, if still in the future. */
  backoffUntil(agentId: string): number | undefined {
    const record = this.#records.get(agentId);
    if (!record || record.parked || record.backoffUntilMs === undefined) return undefined;
    if (record.backoffUntilMs <= this.#now()) {
      record.backoffUntilMs = undefined;
      return undefined;
    }
    return record.backoffUntilMs;
  }

  /** Whether the current wake key for `agentId` is parked after streak 3. */
  isParked(agentId: string): boolean {
    return this.#records.get(agentId)?.parked === true;
  }

  /** Settles the active wake turn when the runtime emits `completed`. */
  noteTurnCompleted(
    agentId: string,
    outcome: { status: "completed" | "interrupted" | "failed"; toolCalls?: number },
  ): WakeLoopTurnOutcome {
    const active = this.#activeTurns.get(agentId);
    this.#activeTurns.delete(agentId);
    const reportedTools = outcome.toolCalls ?? 0;
    if (!active) {
      if (reportedTools > 0) this.#records.delete(agentId);
      return { action: "none", streak: this.#records.get(agentId)?.streak ?? 0 };
    }
    const totalTools = active.toolCalls + reportedTools;
    if (totalTools > 0 || active.coforgeActions > 0) {
      this.#records.delete(agentId);
      return { action: "reset", streak: 0, key: active.key };
    }
    if (outcome.status !== "completed") {
      return {
        action: "none",
        streak: this.#records.get(agentId)?.streak ?? 0,
        key: active.key,
      };
    }
    const previous = this.#records.get(agentId);
    const streak = (previous?.key === active.key ? previous.streak : 0) + 1;
    if (streak >= WAKE_LOOP_PARK_STREAK) {
      this.#records.set(agentId, { key: active.key, streak, parked: true });
      logger.warn("Agent wake key parked after repeated unproductive wakes", {
        event: "agent.wake_loop.parked",
        agent_id: agentId,
        wake_key: active.key,
        streak,
      });
      return { action: "parked", streak, key: active.key };
    }
    if (streak >= WAKE_LOOP_BACKOFF_STREAK) {
      const backoffUntilMs = this.#now() + this.#backoffMs;
      this.#records.set(agentId, {
        key: active.key,
        streak,
        backoffUntilMs,
        parked: false,
      });
      logger.warn("Agent wake backed off after consecutive unproductive wakes", {
        event: "agent.wake_loop.backoff",
        agent_id: agentId,
        wake_key: active.key,
        streak,
        backoff_ms: this.#backoffMs,
      });
      return { action: "backoff", streak, key: active.key, backoffUntilMs };
    }
    this.#records.set(agentId, { key: active.key, streak, parked: false });
    return { action: "armed", streak, key: active.key };
  }

  clear(agentId: string): void {
    this.#activeTurns.delete(agentId);
    this.#records.delete(agentId);
  }
}
