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
/** A status read costs one `session/new` + `session/close` on a fresh process: an unforced pass
 * inside this window reuses the last reported status instead of probing back to back. It covers
 * every provider, not only Antigravity: only a page open, a login or a logout forces a probe. */
export const RUNTIME_AUTH_STATUS_THROTTLE_MS = 60_000;

/** Every runtime with an auth-status surface, read together. */
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
 * Collects the login status of every runtime with an auth-status surface and reports it. A runtime the
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
  /** The providers the queued pass reads, or undefined for every one of them. */
  #next: ReadonlySet<RuntimeAuthProvider> | undefined;
  /** The last collection reported, whose statuses a partial pass leaves alone. */
  #last: RuntimeAuthCollection | undefined;
  /** When each provider was last actually read — an unforced pass inside this window reuses the
   * last report's status so a status read's `session/new` never probes back to back. */
  #readAt = new Map<RuntimeAuthProvider, number>();

  constructor(dependencies: RuntimeAuthStatusSources) {
    this.#dependencies = dependencies;
  }

  async refresh(options: { requireReport?: boolean; force?: boolean } = {}): Promise<void> {
    const reported = await this.#enqueue(undefined, options.force === true);
    if (options.requireReport && !reported) throw new Error("Runtime login status report failed");
  }

  /**
   * Reads one runtime again and reports it beside every other runtime's last status: what a page
   * asks for when it opens that runtime, which may have been signed in or out on the Computer
   * itself. Providers never read yet are read too, so the report is never missing one.
   */
  async refreshProvider(
    provider: RuntimeAuthProvider,
    options: { requireReport?: boolean; force?: boolean } = {},
  ): Promise<void> {
    const reported = await this.#enqueue(new Set([provider]), options.force === true);
    if (options.requireReport && !reported) throw new Error("Runtime login status report failed");
  }

  /** A queued pass inherits any asker's force — one page-open or post-login refresh makes the
   * queued pass bypass the throttle for every provider it covers. */
  #nextForce = false;
  #enqueue(providers?: ReadonlySet<RuntimeAuthProvider>, force = false): Promise<boolean> {
    if (!this.#running) {
      this.#next = undefined;
      return this.#start(providers, force);
    }
    // A queued pass keeps the union of what was asked for: a whole one subsumes partial ones.
    this.#next =
      this.#next === undefined || providers === undefined
        ? undefined
        : new Set([...this.#next, ...providers]);
    this.#nextForce = this.#nextForce || force;
    this.#again ??= this.#running.then(() => {
      this.#again = undefined;
      const next = this.#next;
      const nextForce = this.#nextForce;
      this.#next = undefined;
      this.#nextForce = false;
      return this.#start(next, nextForce);
    });
    return this.#again;
  }

  #start(providers?: ReadonlySet<RuntimeAuthProvider>, force = false): Promise<boolean> {
    const running = this.#collect(providers, force).finally(() => {
      if (this.#running === running) this.#running = undefined;
    });
    this.#running = running;
    return running;
  }

  async #collect(providers?: ReadonlySet<RuntimeAuthProvider>, force = false): Promise<boolean> {
    const { installedProviders, report, now = Date.now } = this.#dependencies;
    const installed = new Set(await installedProviders().catch(() => [] as readonly string[]));
    const previous = new Map(this.#last?.runtimes.map((runtime) => [runtime.provider, runtime]));
    const runtimes = await Promise.all(
      RUNTIME_AUTH_PROVIDERS.map(async (provider) => {
        if (!installed.has(provider))
          return { provider, state: "unavailable", unavailableReason: "not_installed" } as const;
        if (providers && !providers.has(provider)) {
          const kept = previous.get(provider);
          if (kept) return kept;
        }
        // Throttle: an unforced pass inside the window reuses the last read's status. A forced
        // pass — a page open, a login or logout landing — always runs a real probe.
        const fresh =
          !force &&
          this.#last &&
          now() - (this.#readAt.get(provider) ?? 0) < RUNTIME_AUTH_STATUS_THROTTLE_MS;
        return fresh ? (previous.get(provider) ?? this.#read(provider)) : this.#read(provider);
      }),
    );
    const collection = { collectedAtMs: now(), runtimes };
    try {
      await report(collection);
      this.#last = collection;
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
    this.#readAt.set(provider, (this.#dependencies.now ?? Date.now)());
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
