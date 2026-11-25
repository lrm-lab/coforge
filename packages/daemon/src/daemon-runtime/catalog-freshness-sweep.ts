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
  #running: { id: string; promise: Promise<void> } | undefined;

  constructor(ports: CatalogFreshnessSweepPorts) {
    this.#ports = ports;
  }

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => {
      if (this.#running) {
        logger.info("Code Agent catalog sweep still running", {
          event: "code_agent_catalog:sweep_joined",
          sweep_id: this.#running.id,
        });
        return;
      }
      void this.sweep();
    }, CATALOG_FRESHNESS_SWEEP_MS);
    this.#timer.unref();
  }

  stop(): void {
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  sweep(): Promise<void> {
    if (this.#running) return this.#running.promise;
    const id = crypto.randomUUID();
    const startedAt = performance.now();
    let outcome: "ok" | "failed" = "ok";
    logger.info("Code Agent catalog sweep started", {
      event: "code_agent_catalog:sweep_started",
      sweep_id: id,
    });
    const promise = this.#sweep()
      .catch((error: unknown) => {
        outcome = "failed";
        logger.warn("Code Agent catalog freshness sweep failed", {
          event: "code_agent_catalog:freshness_sweep_failed",
          sweep_id: id,
          error: thrownMessage(error),
        });
      })
      .finally(() => {
        this.#running = undefined;
        logger.info("Code Agent catalog sweep finished", {
          event: "code_agent_catalog:sweep_finished",
          sweep_id: id,
          duration_ms: Math.round(performance.now() - startedAt),
          outcome,
        });
      });
    this.#running = { id, promise };
    return promise;
  }

  async #sweep(): Promise<void> {
    const transport = this.#ports.transport();
    if (!transport) {
      // The one reason this class can stop on: said out loud, so "no probe happened" is never
      // confused with "the timer never ran" (task #42).
      logger.info("Code Agent catalog sweep skipped", {
        event: "code_agent_catalog:sweep_skipped",
        reason: "no_transport",
        outcome: "skipped",
      });
      return;
    }
    await this.#ports.recheck(transport);
  }
}
