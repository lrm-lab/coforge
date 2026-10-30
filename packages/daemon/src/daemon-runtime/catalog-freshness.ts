import { getLogger } from "@logtape/logtape";
import {
  diagnosticErrorCode,
  type CodeAgentModelCatalog,
  type RuntimeMetadata,
  type RuntimeProvider,
} from "@lrm/coforge-sdk/internal";
import type { CatalogDiscoveryFailure } from "#src/code-agent/runtime-inventory";
import type { DaemonConnectionClient } from "#src/connection/daemon-connection-client";
import type { CodeAgentDiscovery } from "./code-agent-inventory-sync";
import { CatalogRetrySchedule } from "./catalog-retry-schedule";

const logger = getLogger(["coforge", "daemon", "runtime"]);

/**
 * Why a provider's catalog probe failed, as the runtime report carries it: a launch handshake or
 * version floor that failed makes the runtime unusable. Other failures leave the runtime usable
 * and are retried on a backoff.
 */
export function reportedWithCatalogFailures(
  runtimes: RuntimeMetadata[],
  failures: readonly CatalogDiscoveryFailure[],
): RuntimeMetadata[] {
  return runtimes.map((runtime) => {
    const failure = failures.find((entry) => entry.provider === runtime.provider);
    if (failure && (failure.code === "start_failed" || failure.code === "version_unsupported"))
      return {
        ...runtime,
        unavailableCode: failure.code,
        ...(failure.diagnostic ? { diagnostic: failure.diagnostic } : {}),
      };
    return runtime;
  });
}

export type CatalogFreshnessPorts = Readonly<{
  discovery: Pick<CodeAgentDiscovery, "cachedCatalogs" | "catalogs">;
  owner: { workspaceId: string; computerId: string };
  /** Whether `transport` is still the runtime's live transport and the runtime is not stopping. */
  isLive(transport: DaemonConnectionClient): boolean;
  /** Publishes one inventory message: the drift and retry paths both report the ordinary way. */
  report(
    transport: DaemonConnectionClient,
    requestId: string,
    runtimes: RuntimeMetadata[],
    catalogs: CodeAgentModelCatalog[],
  ): Promise<void>;
}>;

/**
 * What to re-discover while a connection stays up: a catalog whose probe-cache key moved (an
 * installed update, a sign-in or a sign-out), and a provider whose last probe failed once its
 * backoff elapsed. A first scan can fail for a reason that passes — a network fetch that timed out
 * while every runtime was probed at once — so a failure is a delay, never a verdict.
 */
export class CatalogFreshness {
  readonly #ports: CatalogFreshnessPorts;
  readonly #retries = new CatalogRetrySchedule();

  constructor(ports: CatalogFreshnessPorts) {
    this.#ports = ports;
  }

  /** Records one discovery pass: what it failed on waits longer, what it found is forgotten. */
  settle(
    failures: readonly CatalogDiscoveryFailure[],
    catalogs: readonly CodeAgentModelCatalog[],
    now = Date.now(),
  ): void {
    this.#retries.settle(failures, catalogs, now);
  }

  /** Re-discovers what moved on disk, then retries the providers whose wait has elapsed. */
  async recheck(
    transport: DaemonConnectionClient,
    runtimes: RuntimeMetadata[] | undefined,
    now = Date.now(),
  ): Promise<void> {
    if (!runtimes || !this.#ports.isLive(transport)) return;
    const { changedProviders = [] } = await this.#ports.discovery.cachedCatalogs(runtimes);
    if (!changedProviders.length && !this.#retries.due(now).length) return;
    if (changedProviders.length)
      logger.info("Code Agent catalog changed on disk; refreshing", {
        event: "code_agent_catalog:changed",
        request_id: crypto.randomUUID(),
        ...this.#scope(),
        providers: changedProviders,
        outcome: "started",
      });
    if (!changedProviders.length || !this.#ports.isLive(transport)) {
      for (const provider of this.#retries.due(now))
        await this.#retry(provider, runtimes, transport);
      return;
    }
    // A moved key re-discovers every provider in one pass, as a refresh does; a provider that
    // failed then is retried alone below, never holding another provider's catalog up.
    const { catalogs, failures } = await this.#ports.discovery.catalogs(runtimes);
    this.settle(failures, catalogs);
    if (!this.#ports.isLive(transport)) return;
    await this.#ports.report(
      transport,
      crypto.randomUUID(),
      reportedWithCatalogFailures(runtimes, failures),
      catalogs,
    );
    for (const provider of this.#retries.due(now)) await this.#retry(provider, runtimes, transport);
  }

  /** One failed provider's catalog, re-discovered on its own after its wait elapsed. */
  async #retry(
    provider: RuntimeProvider,
    runtimes: RuntimeMetadata[],
    transport: DaemonConnectionClient,
  ): Promise<void> {
    const requestId = crypto.randomUUID();
    try {
      const { catalogs, failures } = await this.#ports.discovery.catalogs(runtimes, {
        force: true,
        provider,
      });
      // A retry that names no failure is done, catalog or not: the runtime reported nothing to
      // offer, which the inventory already says.
      this.#retries.settle(failures, failures.length ? [] : [{ provider }], Date.now());
      if (!this.#ports.isLive(transport)) return;
      if (catalogs.length)
        await this.#ports.report(
          transport,
          requestId,
          reportedWithCatalogFailures(runtimes, failures),
          catalogs,
        );
      logger.info("Code Agent catalog retry completed", {
        event: "code_agent_catalog:retry_completed",
        request_id: requestId,
        ...this.#scope(),
        provider,
        catalog_count: catalogs.length,
        outcome: failures.length ? "failed" : "ok",
      });
    } catch (error) {
      logger.warning("Code Agent catalog retry failed", {
        event: "code_agent_catalog:retry_failed",
        request_id: requestId,
        ...this.#scope(),
        provider,
        error_code: diagnosticErrorCode(error),
        outcome: "failed",
      });
    }
  }

  #scope() {
    return {
      workspace_id: this.#ports.owner.workspaceId,
      computer_id: this.#ports.owner.computerId,
    };
  }
}
