import { getLogger } from "@logtape/logtape";
import { thrownMessage } from "@lrm/coforge-sdk/internal";
import type { DaemonConnectionClient } from "#src/connection/daemon-connection-client";

const logger = getLogger(["coforge", "daemon", "runtime"]);

/** How often the daemon looks for model catalogs that changed on disk. A sign-in, a sign-out or a
 * CLI update can happen while the Computer keeps running; nothing tells the daemon, so the sweep
 * compares the probe-cache keys instead of waiting for the next reconnect. */
export const CATALOG_FRESHNESS_SWEEP_MS = 10 * 60_000;

export type CatalogFreshnessSweepPorts = Readonly<{
  /** The live connection, or undefined while the runtime is not up or is stopping. */
  transport(): DaemonConnectionClient | undefined;
  /** Re-discovers the catalogs whose key changed and re-reports them; a no-op when unchanged. */
  recheck(transport: DaemonConnectionClient): Promise<void>;
}>;

/**
 * Every `CATALOG_FRESHNESS_SWEEP_MS`, asks the inventory which cached catalogs no longer match
 * their on-disk key, and re-discovers those. Reading the keys costs a few file stats; only an
 * actual change (an installed update, a sign-in or sign-out) spawns a provider CLI.
 */
export class CatalogFreshnessSweep {
  readonly #ports: CatalogFreshnessSweepPorts;
  #timer: ReturnType<typeof setInterval> | undefined;
  #running: Promise<void> | undefined;

  constructor(ports: CatalogFreshnessSweepPorts) {
    this.#ports = ports;
  }

  /** Idempotent; the timer never keeps the process alive. */
  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => void this.sweep(), CATALOG_FRESHNESS_SWEEP_MS);
    this.#timer.unref();
  }

  stop(): void {
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** One sweep; a sweep still running is joined, not repeated. Never rejects. */
  sweep(): Promise<void> {
    this.#running ??= this.#sweep()
      .catch((error: unknown) =>
        logger.warn("Code Agent catalog freshness sweep failed", {
          event: "code_agent_catalog:freshness_sweep_failed",
          error: thrownMessage(error),
        }),
      )
      .finally(() => {
        this.#running = undefined;
      });
    return this.#running;
  }

  async #sweep(): Promise<void> {
    const transport = this.#ports.transport();
    if (!transport) return;
    await this.#ports.recheck(transport);
  }
}
