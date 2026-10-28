import {
  RUNTIME_PROVIDER,
  WORKSPACE_PROTOCOL_MAJOR,
  type CodeAgentModelCatalog,
  type DaemonRuntimeCommandCodeEffortReadRequest,
  type DaemonRuntimeProviderModelRefreshRequest,
  type RuntimeMetadata,
} from "@lrm/coforge-sdk/internal";
import { readHostCommandCodeEfforts } from "#src/code-agent/command-code/effort-read";
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

// Deliberately the runtime's category: these records predate this module and keep their routing.
const logger = getLogger(["coforge", "daemon", "runtime"]);

/**
 * The injectable half of Code Agent discovery. `runtimes` is the fast, always-awaited probe;
 * `cachedCatalogs` is a disk-only read (no spawning) used for the same report; `catalogs` is the
 * live, possibly-spawning discovery. Explicit refreshes forbid cached fallback.
 */
export type CodeAgentDiscovery = {
  runtimes(): Promise<RuntimeMetadata[]>;
  cachedCatalogs(
    runtimes: RuntimeMetadata[],
  ): Promise<{ catalogs: CodeAgentModelCatalog[]; needsRefresh: boolean }>;
  catalogs(
    runtimes: RuntimeMetadata[],
    options?: { force: boolean },
  ): Promise<CodeAgentModelCatalog[]>;
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
  #effortChain: Promise<void> = Promise.resolve();
  #runtimeVersions = new Map<RuntimeMetadata["provider"], string>();
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
    this.#effortChain = this.#effortChain
      .catch(() => {})
      .then(() => this.#answerEffortRead(request, transport));
    return this.#effortChain;
  }

  async #answerEffortRead(
    request: DaemonRuntimeCommandCodeEffortReadRequest,
    transport: DaemonConnectionClient,
  ): Promise<void> {
    const scope = {
      request_id: request.requestId,
      workspace_id: this.#owner.workspaceId,
      computer_id: this.#owner.computerId,
    };
    const directory = this.#discovery.stateDirectory;
    let result: Awaited<ReturnType<typeof readHostCommandCodeEfforts>>;
    try {
      result = directory
        ? await readHostCommandCodeEfforts(
            directory,
            request.modelId,
            this.#runtimeVersions.get(RUNTIME_PROVIDER.COMMAND_CODE),
          )
        : { status: "failed", code: "unavailable" };
    } catch (error) {
      logger.warning("Command Code effort read failed", {
        event: "command_code_effort:read_failed",
        ...scope,
        error_code: diagnosticErrorCode(error),
        outcome: "failed",
      });
      if (!this.#isLive(transport)) return;
      await transport.sendCommandCodeEffortReadResult?.({
        protocolMajor: WORKSPACE_PROTOCOL_MAJOR,
        requestId: request.requestId,
        workspaceId: this.#owner.workspaceId,
        computerId: this.#owner.computerId,
        accepted: false,
        status: "failed",
        efforts: [],
      });
      return;
    }
    if (!this.#isLive(transport)) return;
    if (result.status === "failed") {
      logger.warning("Command Code effort read failed", {
        event: "command_code_effort:read_failed",
        ...scope,
        error_code: result.code,
        outcome: "failed",
      });
    } else {
      logger.info("Command Code effort read completed", {
        event: "command_code_effort:read_completed",
        ...scope,
        effort_count: result.efforts.length,
        outcome: "ok",
      });
    }
    await transport.sendCommandCodeEffortReadResult?.({
      protocolMajor: WORKSPACE_PROTOCOL_MAJOR,
      requestId: request.requestId,
      workspaceId: this.#owner.workspaceId,
      computerId: this.#owner.computerId,
      accepted: result.status === "ready",
      status: result.status,
      efforts: result.status === "ready" ? result.efforts : [],
    });
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
      status: "refreshed" | "error";
      message?: string;
      catalogs?: CodeAgentModelCatalog[];
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
      const catalogs = await this.#discovery.catalogs(runtimes, { force: true });
      if (!this.#isLive(transport)) return;
      await this.#sendInventory(transport, requestId, runtimes, catalogs);
      const resolved = await this.#resolveDevinEfforts(runtimes, catalogs, scope);
      if (resolved && this.#isLive(transport))
        await this.#sendInventory(transport, crypto.randomUUID(), runtimes, resolved);
      this.#runtimeAuth?.inventoryObserved(runtimes);
      logger.info("Code Agent catalog refresh completed", {
        event: "code_agent_catalog:refresh_completed",
        ...scope,
        catalog_count: catalogs.length,
        elapsed_ms: Math.round(performance.now() - startedAt),
        outcome: "ok",
      });
      await reply({ accepted: true, status: "refreshed", catalogs: resolved ?? catalogs });
    } catch (error) {
      logger.warning("Code Agent catalog refresh failed", {
        event: "code_agent_catalog:refresh_failed",
        ...scope,
        error_code: diagnosticErrorCode(error),
        outcome: "failed",
      });
      if (!this.#isLive(transport)) return;
      await reply({
        accepted: false,
        status: "error",
        message: error instanceof Error ? error.message : "model refresh failed",
      }).catch(() => {});
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
      const catalogs = await this.#discovery.catalogs(runtimes);
      if (!this.#isLive(transport)) return;
      await this.#sendInventory(transport, requestId, runtimes, catalogs);
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
      if (efforts.length !== current.length || efforts.some((value, i) => value !== current[i]))
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
