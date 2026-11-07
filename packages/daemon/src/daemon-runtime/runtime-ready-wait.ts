import { getLogger } from "@logtape/logtape";
import { scheduleUnrefTimer, type UnrefTimerSchedule } from "./unref-timer";

const logger = getLogger(["coforge", "daemon", "runtime"]);

/** How long publications may be held before the daemon says so. Publications are held from the
 * moment their listeners are installed, so a hold with no release looks like a healthy daemon that
 * silently ignores every control intent (task #630). Two minutes is well past a normal start and
 * far short of the hours an outage can last. */
export const READY_WAIT_LOG_TIMEOUT_MS = 2 * 60_000;

/** How often a hold still not released repeats its report. A long outage keeps a voice without
 * filling the log; a release ends it. */
export const READY_WAIT_LOG_REPEAT_MS = 10 * 60_000;

export type RuntimeReadyWaitWatchPorts = Readonly<{
  /** How many publications are held right now: the control hold plus the delivery notices. */
  heldCount(): number;
  timeoutMs?: number;
  repeatMs?: number;
  schedule?: UnrefTimerSchedule;
}>;

/**
 * Reports a hold on publications that outlasts {@link READY_WAIT_LOG_TIMEOUT_MS}, with how long it
 * has lasted, how many ready attempts it survived and how many publications wait behind it.
 *
 * The clock runs from the first hold and only {@link settle} ends it: a ready that fails and is
 * retried keeps holding, and keeps the clock. That is what an outage looks like — each attempt
 * answers in seconds, yet the publications stay held for hours (task #687) — so timing a single
 * handshake would report nothing at all. Log only: nothing about the hold, the buffer or the
 * replay changes.
 */
export class RuntimeReadyWaitWatch {
  readonly #ports: RuntimeReadyWaitWatchPorts;
  #cancel: (() => void) | undefined;
  #startedAtMs: number | undefined;
  #attempts = 0;

  constructor(ports: RuntimeReadyWaitWatchPorts) {
    this.#ports = ports;
  }

  /** A start installed its publication listeners, so publications are held: the first call starts
   * the clock, and a later one only means a fresh hold replaced the last. The attempts themselves
   * are counted by {@link attempt}, which the connection calls once per ready request. */
  begin(workspaceId: string): void {
    if (this.#startedAtMs !== undefined) return;
    this.#startedAtMs = Date.now();
    this.#arm(workspaceId, this.#ports.timeoutMs ?? READY_WAIT_LOG_TIMEOUT_MS);
  }

  /** One ready attempt is under way; the connection's retries call this too. */
  attempt(): void {
    this.#attempts += 1;
  }

  /** The hold ended: what was held is released, or the runtime is going away. */
  settle(): void {
    this.#cancel?.();
    this.#cancel = undefined;
    this.#startedAtMs = undefined;
    this.#attempts = 0;
  }

  #arm(workspaceId: string, milliseconds: number): void {
    this.#cancel = (this.#ports.schedule ?? scheduleUnrefTimer)(async () => {
      const startedAtMs = this.#startedAtMs;
      if (startedAtMs === undefined) return;
      logger.warn("Publications are still held; the ready handshake has not completed", {
        event: "runtime:ready_wait_long",
        workspace_id: workspaceId,
        waited_ms: Date.now() - startedAtMs,
        ready_attempts: this.#attempts,
        held_control_count: this.#ports.heldCount(),
        outcome: "waiting",
      });
      if (this.#startedAtMs === undefined) return;
      this.#arm(workspaceId, this.#ports.repeatMs ?? READY_WAIT_LOG_REPEAT_MS);
    }, milliseconds);
  }
}
