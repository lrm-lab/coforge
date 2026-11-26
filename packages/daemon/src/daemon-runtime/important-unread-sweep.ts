import { getLogger } from "@logtape/logtape";
import { thrownMessage } from "@lrm/coforge-sdk/internal";

const logger = getLogger(["coforge", "daemon", "message-attention"]);

export const IMPORTANT_UNREAD_SWEEP_MS = 30_000;

export type ImportantUnreadSweepPorts = Readonly<{
  flushDue(): number;
  onStop?(): void;
}>;

export class ImportantUnreadSweep {
  readonly #ports: ImportantUnreadSweepPorts;
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(ports: ImportantUnreadSweepPorts) {
    this.#ports = ports;
  }

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => this.sweep(), IMPORTANT_UNREAD_SWEEP_MS);
    this.#timer.unref();
  }

  stop(): void {
    clearInterval(this.#timer);
    this.#timer = undefined;
    this.#ports.onStop?.();
  }

  sweep(): void {
    try {
      const pending = this.#ports.flushDue();
      logger.debug("Agent unread notice sweep", {
        event: "agent.inbox_notice.sweep",
        agents_pending: pending,
      });
    } catch (error: unknown) {
      logger.warn("Agent unread notice sweep failed", {
        event: "agent.inbox_notice.sweep_failed",
        error: thrownMessage(error),
      });
    }
  }
}
