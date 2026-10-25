import { getLogger } from "@logtape/logtape";
import {
  RUNTIME_AUTH_PROVIDERS,
  sanitizeRuntimeAuthStatus,
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
 * many arrive, and resolves once that one has reported. A failed report is logged, never thrown:
 * a server that does not know the method yet is not the caller's problem.
 */
export class RuntimeAuthStatusCollector {
  readonly #dependencies: RuntimeAuthStatusSources;
  #running: Promise<void> | undefined;
  #again: Promise<void> | undefined;

  constructor(dependencies: RuntimeAuthStatusSources) {
    this.#dependencies = dependencies;
  }

  refresh(): Promise<void> {
    if (!this.#running) return this.#start();
    this.#again ??= this.#running.then(() => {
      this.#again = undefined;
      return this.#start();
    });
    return this.#again;
  }

  #start(): Promise<void> {
    const running = this.#collect().finally(() => {
      if (this.#running === running) this.#running = undefined;
    });
    this.#running = running;
    return running;
  }

  async #collect(): Promise<void> {
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
    } catch (error) {
      logger.debug("runtime auth status report failed", { error });
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
      logger.debug("runtime auth status read failed", { provider, error });
      return { provider, state: "unknown" };
    }
  }
}
