import {
  RUNTIME_PROVIDER,
  WORKSPACE_PROTOCOL_MAJOR,
  type CodeAgentModelCatalog,
  type DaemonRuntimeCommandCodeEffortReadRequest,
  type DaemonRuntimeProviderModelRefreshRequest,
  type ProviderModelRefreshResult,
  type RuntimeMetadata,
  type RuntimeProvider,
} from "@lrm/coforge-sdk/internal";
import type { CatalogDiscoveryFailure } from "#src/code-agent/runtime-inventory";
import { readHostDevinEfforts, type DevinCatalogEfforts } from "#src/code-agent/devin/effort-read";
import { discoverPiModels } from "@coforge/agent";
import { getLogger } from "@logtape/logtape";
import {
  discoverCodeAgentRuntimes,
  discoverCodeAgentCatalogs,
  loadCachedCodeAgentCatalogs,
} from "#src/code-agent/runtime-inventory";
import { hostCodeAgentProbe } from "#src/code-agent/runtime-probe";
import type { DaemonConnectionClient } from "#src/connection/daemon-connection-client";
import type { RuntimeAuthReporter } from "./runtime-auth-reporter";
import { diagnosticErrorCode } from "@lrm/coforge-sdk/internal";
import { CommandCodeEffortReads } from "./command-code-effort-reads";
import { CatalogFreshness, reportedWithCatalogFailures } from "./catalog-freshness";

// Deliberately the runtime's category: these records predate this module and keep their routing.
const logger = getLogger(["coforge", "daemon", "runtime"]);

/**
 * The injectable half of Code Agent discovery. `runtimes` is the fast, always-awaited probe;
 * `cachedCatalogs` is a disk-only read (no spawning) used for the same report; `catalogs` is the
 * live, possibly-spawning discovery. Explicit refreshes forbid cached fallback.
 */
export type CodeAgentDiscovery = {
  runtimes(): Promise<RuntimeMetadata[]>;
  /** `changedProviders` names the catalogs whose on-disk key moved; a discovery that cannot tell
   * leaves it out. */
  cachedCatalogs(runtimes: RuntimeMetadata[]): Promise<{
    catalogs: CodeAgentModelCatalog[];
    needsRefresh: boolean;
    changedProviders?: RuntimeProvider[];
  }>;
  catalogs(
    runtimes: RuntimeMetadata[],
    options?: { force: boolean; provider?: RuntimeProvider },
  ): Promise<{
    catalogs: CodeAgentModelCatalog[];
    failures: CatalogDiscoveryFailure[];
  }>;
  /** This Computer's probe-cache directory. Absent only for test discoveries. */
  stateDirectory?: string;
};

export function defaultCodeAgentDiscovery(stateDirectory: string): CodeAgentDiscovery {
  const host = {
    probe: hostCodeAgentProbe,
    piModels: discoverPiModels,
    cacheDirectory: stateDirectory,
  };
  return {
    runtimes: () => discoverCodeAgentRuntimes(host),
    cachedCatalogs: (runtimes) => loadCachedCodeAgentCatalogs(runtimes, host),
    catalogs: (runtimes, options) => discoverCodeAgentCatalogs(runtimes, { ...host, ...options }),
    stateDirectory,
  };
}

/** What `reportRuntimes` reported, and whether its cached catalogs need a live refresh. */
export type CodeAgentRuntimesReport = { runtimes: RuntimeMetadata[]; needsCatalogRefresh: boolean };

/** Keeps the cloud's copy of this Computer's Code Agent runtimes and model catalogs current. */
export class CodeAgentInventorySync {
  readonly #discovery: CodeAgentDiscovery;
  /** The Workspace and Computer every report and log record is scoped to. */
  readonly #owner: { workspaceId: string; computerId: string };
  /** Whether `transport` is still the runtime's live transport and the runtime is not stopping. */
  readonly #isLive: (transport: DaemonConnectionClient) => boolean;
  /** Told which runtimes each report found, so login status follows the inventory. */
  readonly #runtimeAuth: RuntimeAuthReporter | undefined;
  /** Serializes on-demand model-catalog refreshes (one CLI-spawning discovery at a time). */
  #modelRefreshChain: Promise<void> = Promise.resolve();
  /** Serializes Command Code effort reads so two forms do not spawn two processes at once. */
  readonly #efforts: CommandCodeEffortReads;
  #runtimeVersions = new Map<RuntimeMetadata["provider"], string>();
  /** The runtimes of the last report, so a freshness check judges the same installed set. */
  #reportedRuntimes: RuntimeMetadata[] | undefined;
  /** What to re-discover while the connection stays up: moved catalogs, and failed probes. */
  readonly #freshness: CatalogFreshness;
  /** Devin's `thought_level` sweep; production resolves this Computer's `devin`. */
  readonly #devinEfforts: (
    stateDirectory: string | undefined,
    version: string | undefined,
    modelIds: readonly string[],
  ) => Promise<DevinCatalogEfforts>;

  constructor(
    discovery: CodeAgentDiscovery,
    owner: { workspaceId: string; computerId: string },
    isLive: (transport: DaemonConnectionClient) => boolean,
    runtimeAuth?: RuntimeAuthReporter,
    devinEfforts?: (
      stateDirectory: string | undefined,
      version: string | undefined,
      modelIds: readonly string[],
    ) => Promise<DevinCatalogEfforts>,
  ) {
    this.#runtimeAuth = runtimeAuth;
    this.#discovery = discovery;
    this.#owner = owner;
    this.#isLive = isLive;
    this.#devinEfforts = devinEfforts ?? readHostDevinEfforts;
    this.#freshness = new CatalogFreshness({
      discovery: this.#discovery,
      owner,
      isLive: (transport) => this.#isLive(transport),
      report: async (transport, requestId, runtimes, catalogs) => {
        await this.#sendInventory(transport, requestId, runtimes, catalogs);
      },
    });
    this.#efforts = new CommandCodeEffortReads({
      owner,
      stateDirectory: () => this.#discovery.stateDirectory,
      version: () => this.#runtimeVersions.get(RUNTIME_PROVIDER.COMMAND_CODE),
      isLive: (transport) => this.#isLive(transport),
    });
  }

  /**
   * The fast half of Code Agent discovery: installed runtimes plus whatever model catalogs are
   * already on disk from a previous probe. Never spawns a provider CLI beyond what runtime
   * probing itself needs (Codex's `app-server` handshake), so this is safe to await before the
   * daemon reports itself ready to the Coordinator.
   */
  async reportRuntimes(transport: DaemonConnectionClient): Promise<CodeAgentRuntimesReport> {
    const requestId = crypto.randomUUID();
    const scope = this.#scope(requestId);
    try {
      const runtimes = await this.#discovery.runtimes();
      this.#runtimeVersions = new Map(
        runtimes.map((runtime) => [runtime.provider, runtime.version]),
      );
      const { catalogs, needsRefresh } = await this.#discovery.cachedCatalogs(runtimes);
      if (!this.#isLive(transport)) return { runtimes, needsCatalogRefresh: false };
      await this.#sendInventory(transport, requestId, runtimes, catalogs);
      this.#reportedRuntimes = runtimes;
      logger.info("Code Agent inventory reported", {
        event: "code_agent_inventory:reported",
        ...scope,
        runtime_count: runtimes.length,
        catalog_count: catalogs.length,
        outcome: "ok",
      });
      void this.#runtimeAuth?.inventoryReported(runtimes);
      return { runtimes, needsCatalogRefresh: needsRefresh };
    } catch (error) {
      logger.warning("Code Agent inventory report failed", {
        event: "code_agent_inventory:report_failed",
        ...scope,
        error_code: diagnosticErrorCode(error),
        outcome: "failed",
      });
      throw error;
    }
  }

  /** Starts a background live catalog discovery when `report`'s cached catalogs were stale. */
  refreshStaleCatalogs(report: CodeAgentRuntimesReport, transport: DaemonConnectionClient): void {
    // The same chain `refreshModels` uses: one CLI-spawning report at a time, so a queued
    // refresh cannot be overwritten by an older report's later phases on the same transport.
    if (report.needsCatalogRefresh && this.#isLive(transport))
      this.#modelRefreshChain = this.#modelRefreshChain
        .catch(() => {})
        .then(() => this.#reportCatalogs(report.runtimes, transport));
  }

  /** Re-discovers catalogs that moved on disk, then retries the providers whose wait elapsed. */
  recheckCatalogs(transport: DaemonConnectionClient, now = Date.now()): Promise<void> {
    return this.#freshness.recheck(transport, this.#reportedRuntimes, now);
  }

  /** Answers a server model refresh request after every refresh that arrived before it. */
  refreshModels(
    request: DaemonRuntimeProviderModelRefreshRequest,
    transport: DaemonConnectionClient,
  ): Promise<void> {
    // Serialize: each request gets a real discovery, in arrival order, never overlapping.
    this.#modelRefreshChain = this.#modelRefreshChain
      .catch(() => {})
      .then(() => this.#refreshProviderModels(request, transport));
    return this.#modelRefreshChain;
  }

  /** Answers one Command Code effort read after every read that arrived before it. */
  readCommandCodeEfforts(
    request: DaemonRuntimeCommandCodeEffortReadRequest,
    transport: DaemonConnectionClient,
  ): Promise<void> {
    return this.#efforts.read(request, transport);
  }

  /**
   * On-demand model-catalog re-discovery, driven by the server's `daemon:v1:provider:model_refresh`
   * request (the browser's model selector asks for it). Re-runs the same live discovery the
   * background refresh uses, re-reports through the ordinary inventory update so the server's copy
   * is current, then answers the request with the fresh catalog. Serialized by `#modelRefreshChain`,
   * and guarded against shutdown or a replaced transport like `#reportCatalogs`.
   */
  async #refreshProviderModels(
    request: DaemonRuntimeProviderModelRefreshRequest,
    transport: DaemonConnectionClient,
  ): Promise<void> {
    const requestId = crypto.randomUUID();
    const scope = this.#scope(requestId);
    const startedAt = performance.now();
    logger.info("Code Agent catalog refresh started", {
      event: "code_agent_catalog:refresh_started",
      ...scope,
      outcome: "started",
    });
    const reply = async (response: {
      accepted: boolean;
      results: ProviderModelRefreshResult[];
    }): Promise<void> => {
      await transport.sendProviderModelRefreshResult?.({
        protocolMajor: WORKSPACE_PROTOCOL_MAJOR,
        requestId: request.requestId,
        workspaceId: this.#owner.workspaceId,
        computerId: this.#owner.computerId,
        ...response,
      });
    };
    try {
      const runtimes = await this.#discovery.runtimes();
      const { catalogs, failures } = await this.#discovery.catalogs(runtimes, {
        force: true,
        provider: request.provider,
      });
      // A runtime whose launch handshake (start/version) failed its catalog probe is unusable:
      // the report marks it so the settings page names why, not just that it failed.
      const reported = reportedWithCatalogFailures(runtimes, failures);
      this.#freshness.settle(failures, catalogs);
      if (!this.#isLive(transport)) return;
      await this.#sendInventory(transport, requestId, reported, catalogs);
      this.#reportedRuntimes = reported;
      const resolved =
        request.provider === RUNTIME_PROVIDER.DEVIN
          ? await this.#resolveDevinEfforts(reported, catalogs, scope)
          : undefined;
      if (resolved && this.#isLive(transport))
        await this.#sendInventory(transport, crypto.randomUUID(), reported, resolved);
      this.#runtimeAuth?.inventoryObserved(reported);
      logger.info("Code Agent catalog refresh completed", {
        event: "code_agent_catalog:refresh_completed",
        ...scope,
        provider: request.provider,
        catalog_count: catalogs.length,
        failure_count: failures.length,
        elapsed_ms: Math.round(performance.now() - startedAt),
        outcome: failures.length ? "partial" : "ok",
      });
      const finalCatalogs = resolved ?? catalogs;
      const outcomeFor = (provider: RuntimeProvider): ProviderModelRefreshResult => {
        const failure = failures.find((entry) => entry.provider === provider);
        if (failure)
          return {
            provider,
            status: "error",
            code: failure.code,
            ...(failure.diagnostic ? { diagnostic: failure.diagnostic } : {}),
          };
        const catalog = finalCatalogs.find((entry) => entry.provider === provider);
        if (catalog) return { provider, status: "refreshed", catalog };
        const runtime = reported.find((entry) => entry.provider === provider);
        return {
          provider,
          status: "error",
          code: runtime?.unavailableCode ?? "unknown",
          ...(runtime?.diagnostic ? { diagnostic: runtime.diagnostic } : {}),
        };
      };
      const providers = request.provider
        ? [request.provider]
        : reported.map((runtime) => runtime.provider);
      await reply({ accepted: true, results: providers.map(outcomeFor) });
    } catch (error) {
      logger.warning("Code Agent catalog refresh failed", {
        event: "code_agent_catalog:refresh_failed",
        ...scope,
        provider: request.provider,
        error_code: diagnosticErrorCode(error),
        outcome: "failed",
      });
      if (!this.#isLive(transport)) return;
      await reply({ accepted: false, results: [] }).catch(() => {});
    }
  }

  /**
   * The slow half: live model catalog discovery (Kiro and Pi spawn a CLI; Codex calls
   * `model/list`). Always runs in the background, never blocking start or a reconnect, and is
   * guarded against a daemon shutdown or a transport replaced by a later reconnect while it was
   * in flight.
   */
  async #reportCatalogs(
    runtimes: RuntimeMetadata[],
    transport: DaemonConnectionClient,
  ): Promise<void> {
    const requestId = crypto.randomUUID();
    const scope = this.#scope(requestId);
    const startedAt = performance.now();
    logger.info("Code Agent catalog discovery started", {
      event: "code_agent_catalog:summary_started",
      ...scope,
      outcome: "started",
    });
    try {
      const { catalogs, failures } = await this.#discovery.catalogs(runtimes);
      this.#freshness.settle(failures, catalogs);
      if (!this.#isLive(transport)) return;
      const reported = reportedWithCatalogFailures(runtimes, failures);
      await this.#sendInventory(transport, requestId, reported, catalogs);
      if (!this.#isLive(transport)) return;
      const resolved = await this.#resolveDevinEfforts(runtimes, catalogs, scope);
      if (resolved && this.#isLive(transport))
        await this.#sendInventory(transport, crypto.randomUUID(), runtimes, resolved);
      logger.info("Code Agent catalog discovery completed", {
        event: "code_agent_catalog:summary_completed",
        ...scope,
        catalog_count: catalogs.length,
        elapsed_ms: Math.round(performance.now() - startedAt),
        outcome: "ok",
      });
    } catch (error) {
      logger.warning("Code Agent catalog discovery failed", {
        event: "code_agent_catalog:summary_failed",
        ...scope,
        elapsed_ms: Math.round(performance.now() - startedAt),
        error_code: diagnosticErrorCode(error),
        outcome: "failed",
      });
    }
  }

  #scope(requestId: string) {
    return {
      request_id: requestId,
      workspace_id: this.#owner.workspaceId,
      computer_id: this.#owner.computerId,
    };
  }

  /** The Devin effort sweep after a report: a throw is one failed read, not a failed report. */
  async #resolveDevinEfforts(
    runtimes: RuntimeMetadata[],
    catalogs: CodeAgentModelCatalog[],
    scope: Record<string, string>,
  ): Promise<CodeAgentModelCatalog[] | undefined> {
    return this.#devinEffortCatalogs(runtimes, catalogs).catch((error: unknown) => {
      logger.warning("Devin effort sweep failed", {
        event: "code_agent_catalog:devin_efforts_failed",
        ...scope,
        error_code: diagnosticErrorCode(error),
        outcome: "failed",
      });
      return undefined;
    });
  }

  /**
   * Reads the Devin models' `thought_level` choices after the model list already reported and
   * returns the catalogs to publish again, or undefined when the sweep adds nothing or leaves a
   * model unread: an unread model is never reported as effort-less — it keeps its
   * cache-published value for this report.
   */
  async #devinEffortCatalogs(
    runtimes: RuntimeMetadata[],
    catalogs: CodeAgentModelCatalog[],
  ): Promise<CodeAgentModelCatalog[] | undefined> {
    const index = catalogs.findIndex((catalog) => catalog.provider === RUNTIME_PROVIDER.DEVIN);
    const directory = this.#discovery.stateDirectory;
    if (index < 0 || !directory) return undefined;
    const catalog = catalogs[index];
    if (!catalog) return undefined;
    const read = await this.#devinEfforts(
      directory,
      runtimes.find((runtime) => runtime.provider === RUNTIME_PROVIDER.DEVIN)?.version,
      catalog.models.map((model) => model.id),
    );
    if (!read.complete) return undefined;
    let changed = false;
    const models = catalog.models.map((model) => {
      const efforts = read.efforts.get(model.id);
      if (!efforts) return model;
      const current = model.reasoningEfforts;
      if (
        !current ||
        efforts.length !== current.length ||
        efforts.some((value, i) => value !== current[i])
      )
        changed = true;
      return { ...model, reasoningEfforts: [...efforts] };
    });
    if (!changed) return undefined;
    return catalogs.map((candidate, i) => (i === index ? { ...candidate, models } : candidate));
  }

  // Returns the transport's own promise (not an `async` wrapper) so callers await exactly it.
  #sendInventory(
    transport: DaemonConnectionClient,
    requestId: string,
    runtimes: RuntimeMetadata[],
    catalogs: CodeAgentModelCatalog[],
  ) {
    return transport.updateCodeAgents?.({
      protocolMajor: WORKSPACE_PROTOCOL_MAJOR,
      requestId,
      workspaceId: this.#owner.workspaceId,
      computerId: this.#owner.computerId,
      runtimes,
      catalogs,
    });
  }
}
