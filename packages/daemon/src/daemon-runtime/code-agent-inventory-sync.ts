import {
  WORKSPACE_PROTOCOL_MAJOR,
  type CodeAgentModelCatalog,
  type DaemonRuntimeProviderModelRefreshRequest,
  type RuntimeMetadata,
} from "@lrm/coforge-sdk/internal";
import { getLogger } from "@logtape/logtape";
import {
  discoverCodeAgentRuntimes,
  discoverCodeAgentCatalogs,
  loadCachedCodeAgentCatalogs,
} from "#src/code-agent/runtime-inventory";
import type { DaemonConnectionClient } from "#src/connection/daemon-connection";
import { diagnosticErrorCode } from "#src/platform/diagnostic-error-code";

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
};

export function defaultCodeAgentDiscovery(stateDirectory: string): CodeAgentDiscovery {
  return {
    runtimes: () => discoverCodeAgentRuntimes({ cacheDirectory: stateDirectory }),
    cachedCatalogs: (runtimes) =>
      loadCachedCodeAgentCatalogs(runtimes, { cacheDirectory: stateDirectory }),
    catalogs: (runtimes, options) =>
      discoverCodeAgentCatalogs(runtimes, { cacheDirectory: stateDirectory, ...options }),
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
  /** Serializes on-demand model-catalog refreshes (one CLI-spawning discovery at a time). */
  #modelRefreshChain: Promise<void> = Promise.resolve();

  constructor(
    discovery: CodeAgentDiscovery,
    owner: { workspaceId: string; computerId: string },
    isLive: (transport: DaemonConnectionClient) => boolean,
  ) {
    this.#discovery = discovery;
    this.#owner = owner;
    this.#isLive = isLive;
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
    if (report.needsCatalogRefresh && this.#isLive(transport))
      void this.#reportCatalogs(report.runtimes, transport).catch(() => {});
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
      logger.info("Code Agent catalog refresh completed", {
        event: "code_agent_catalog:refresh_completed",
        ...scope,
        catalog_count: catalogs.length,
        elapsed_ms: Math.round(performance.now() - startedAt),
        outcome: "ok",
      });
      await reply({ accepted: true, status: "refreshed", catalogs });
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
