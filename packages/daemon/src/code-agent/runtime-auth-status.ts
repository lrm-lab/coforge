import { getLogger } from "@logtape/logtape";
import {
  RUNTIME_AUTH_PROVIDERS,
  sanitizeRuntimeAuthStatus,
  scrubRuntimeErrorText,
  type RuntimeAuthProvider,
  type RuntimeAuthStatus,
  withDeadline,
} from "@lrm/coforge-anvil";

const logger = getLogger(["coforge", "daemon", "code-agent", "runtime-auth-status"]);

/** How long one runtime's status read may take before it reads as unknown. */
export const RUNTIME_AUTH_STATUS_TIMEOUT_MS = 20_000;

/** Every login-capable runtime's status, read together. */
export type RuntimeAuthCollection = {
  collectedAtMs: number;
  runtimes: RuntimeAuthStatus[];
};

/** What a collector reads from and reports to. */
export type RuntimeAuthStatusSources = {
  /** The providers the runtime inventory found on this Computer. */
  installedProviders(): Promise<readonly string[]>;
  /** One runtime's status through its adapter; rejects when it has none. */
  readStatus(provider: RuntimeAuthProvider): Promise<RuntimeAuthStatus>;
  report(collection: RuntimeAuthCollection): Promise<void>;
  now?: () => number;
  timeoutMs?: number;
};

/**
 * Collects the login status of every runtime with a login flow and reports it. A runtime the
 * inventory did not find is `unavailable/not_installed` without running anything; the others are
 * read in parallel through their adapter, each bounded, and a read that fails, has no adapter yet
 * or outlasts its deadline is `unknown`. Every status is sanitized before it leaves the Computer.
 *
 * One collection runs at a time. A `refresh` while one runs asks for one more afterwards, however
 * many arrive, and resolves once that one has reported. Background refreshes log failed reports;
 * an explicit refresh can require acknowledgment so it cannot claim that stale cloud data is fresh.
 */
export class RuntimeAuthStatusCollector {
  readonly #dependencies: RuntimeAuthStatusSources;
  #running: Promise<boolean> | undefined;
  #again: Promise<boolean> | undefined;

  constructor(dependencies: RuntimeAuthStatusSources) {
    this.#dependencies = dependencies;
  }

  async refresh(options: { requireReport?: boolean } = {}): Promise<void> {
    const reported = await this.#enqueue();
    if (options.requireReport && !reported) throw new Error("Runtime login status report failed");
  }

  #enqueue(): Promise<boolean> {
    if (!this.#running) return this.#start();
    this.#again ??= this.#running.then(() => {
      this.#again = undefined;
      return this.#start();
    });
    return this.#again;
  }

  #start(): Promise<boolean> {
    const running = this.#collect().finally(() => {
      if (this.#running === running) this.#running = undefined;
    });
    this.#running = running;
    return running;
  }

  async #collect(): Promise<boolean> {
    const { installedProviders, report, now = Date.now } = this.#dependencies;
    const installed = new Set(await installedProviders().catch(() => [] as readonly string[]));
    const runtimes = await Promise.all(
      RUNTIME_AUTH_PROVIDERS.map((provider) =>
        installed.has(provider)
          ? this.#read(provider)
          : ({ provider, state: "unavailable", unavailableReason: "not_installed" } as const),
      ),
    );
    try {
      await report({ collectedAtMs: now(), runtimes });
      return true;
    } catch (error) {
      logger.info("runtime auth status report failed", {
        detail: scrubRuntimeErrorText(error instanceof Error ? error.message : String(error)),
      });
      return false;
    }
  }

  async #read(provider: RuntimeAuthProvider): Promise<RuntimeAuthStatus> {
    const timeoutMs = this.#dependencies.timeoutMs ?? RUNTIME_AUTH_STATUS_TIMEOUT_MS;
    try {
      const status = await withDeadline(
        this.#dependencies.readStatus(provider),
        timeoutMs,
        () => new Error(`${provider} login status timed out`),
      );
      return sanitizeRuntimeAuthStatus(status, provider) ?? { provider, state: "unknown" };
    } catch (error) {
      logger.info("runtime auth status read failed", {
        provider,
        detail: scrubRuntimeErrorText(error instanceof Error ? error.message : String(error)),
      });
      return { provider, state: "unknown" };
    }
  }
}
