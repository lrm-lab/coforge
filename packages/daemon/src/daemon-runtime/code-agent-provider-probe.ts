import { getLogger } from "@logtape/logtape";
import {
  WORKSPACE_PROTOCOL_MAJOR,
  type CodeAgentModelCatalog,
  type DaemonRuntimeProviderModelRefreshRequest,
  type ProviderModelRefreshResult,
  type RuntimeMetadata,
  type RuntimeProvider,
} from "@lrm/coforge-sdk/internal";
import type { DaemonConnectionClient } from "#src/connection/daemon-connection-client";
import type { CodeAgentDiscovery } from "./catalog-inventory-types";
import type { RuntimeAuthReporter } from "./runtime-auth-reporter";
import { reportedWithCatalogFailures } from "./catalog-freshness";

const logger = getLogger(["coforge", "daemon", "code-agent", "inventory"]);

export const REPROBE_MIN_INTERVAL_MS = 30_000;

export type ProbeOutcome = Awaited<ReturnType<CodeAgentDiscovery["catalogs"]>>;

export type ProviderProbePorts = {
  discovery: CodeAgentDiscovery;
  owner: { workspaceId: string; computerId: string };
  isLive: (transport: DaemonConnectionClient) => boolean;
  runtimeAuth: RuntimeAuthReporter | undefined;
  now: () => number;
  serialize: <T>(work: () => Promise<T>) => Promise<T>;
  settle: (failures: ProbeOutcome["failures"], catalogs: CodeAgentModelCatalog[]) => void;
  sendInventory: (
    transport: DaemonConnectionClient,
    requestId: string,
    runtimes: RuntimeMetadata[],
    catalogs: CodeAgentModelCatalog[],
  ) => Promise<void>;
  onReported: (runtimes: RuntimeMetadata[]) => void;
  reportedRuntimes: () => RuntimeMetadata[] | undefined;
  resolveEfforts: (
    provider: RuntimeProvider,
    reported: RuntimeMetadata[],
    catalogs: CodeAgentModelCatalog[],
    scope: { workspaceId: string; computerId: string; requestId: string },
  ) => Promise<CodeAgentModelCatalog[] | undefined>;
  sweepableProviders: ReadonlySet<RuntimeProvider>;
};

export class ProviderProbeCoordinator {
  readonly #inFlight = new Map<RuntimeProvider, Promise<ProbeOutcome>>();
  readonly #lastProbedAt = new Map<RuntimeProvider, ProbeOutcome & { atMs: number }>();

  constructor(private readonly ports: ProviderProbePorts) {}

  reprobe(
    provider: RuntimeProvider,
    trigger: string,
    transport: DaemonConnectionClient,
  ): Promise<void> {
    if (!this.ports.isLive(transport)) return Promise.resolve();
    logger.info("Code Agent catalog reprobe requested", {
      event: "code_agent_catalog:reprobe",
      provider,
      trigger,
    });
    return this.enqueue(provider, transport).then(
      () => {},
      () => {},
    );
  }

  refreshProvider(
    request: DaemonRuntimeProviderModelRefreshRequest,
    transport: DaemonConnectionClient,
  ): Promise<void> {
    if (!request.provider) {
      return this.#replyAfter(
        request,
        transport,
        this.ports.serialize(() => this.#run(undefined, transport, crypto.randomUUID())),
      );
    }
    const provider = request.provider;
    const inFlight = this.#inFlight.get(provider);
    if (inFlight) return this.#replyAfter(request, transport, inFlight);
    const last = this.#lastProbedAt.get(provider);
    if (last && this.ports.now() - last.atMs < REPROBE_MIN_INTERVAL_MS)
      return this.#replyAfter(request, transport, Promise.resolve(last));
    return this.#replyAfter(request, transport, this.enqueue(provider, transport));
  }

  enqueue(provider: RuntimeProvider, transport: DaemonConnectionClient): Promise<ProbeOutcome> {
    const existing = this.#inFlight.get(provider);
    if (existing) return existing;
    const probe = this.ports
      .serialize(() => this.#run(provider, transport, crypto.randomUUID()))
      .finally(() => {
        if (this.#inFlight.get(provider) === probe) this.#inFlight.delete(provider);
      });
    this.#inFlight.set(provider, probe);
    return probe;
  }

  async #run(
    provider: RuntimeProvider | undefined,
    transport: DaemonConnectionClient,
    requestId: string,
  ): Promise<ProbeOutcome> {
    const runtimes = await this.ports.discovery.runtimes();
    const { catalogs, failures } = await this.ports.discovery.catalogs(runtimes, {
      force: true,
      provider,
    });
    const reported = reportedWithCatalogFailures(runtimes, failures);
    this.ports.settle(failures, catalogs);
    if (this.ports.isLive(transport)) {
      await this.ports.sendInventory(transport, requestId, reported, catalogs);
      this.ports.onReported(reported);
      this.ports.runtimeAuth?.inventoryObserved(reported);
    }
    if (provider) this.#lastProbedAt.set(provider, { atMs: this.ports.now(), catalogs, failures });
    return { catalogs, failures };
  }

  async #replyAfter(
    request: DaemonRuntimeProviderModelRefreshRequest,
    transport: DaemonConnectionClient,
    probe: Promise<ProbeOutcome>,
  ): Promise<void> {
    const requestId = crypto.randomUUID();
    const scope = { ...this.ports.owner, requestId };
    const reply = async (response: {
      accepted: boolean;
      results: ProviderModelRefreshResult[];
    }): Promise<void> => {
      await transport.sendProviderModelRefreshResult?.({
        protocolMajor: WORKSPACE_PROTOCOL_MAJOR,
        requestId: request.requestId,
        workspaceId: this.ports.owner.workspaceId,
        computerId: this.ports.owner.computerId,
        ...response,
      });
    };
    try {
      const { catalogs, failures } = await probe;
      if (!this.ports.isLive(transport)) return;
      const reported = this.ports.reportedRuntimes() ?? [];
      const resolved =
        request.provider && this.ports.sweepableProviders.has(request.provider)
          ? await this.ports.resolveEfforts(request.provider, reported, catalogs, scope)
          : undefined;
      if (resolved && this.ports.isLive(transport))
        await this.ports.sendInventory(transport, crypto.randomUUID(), reported, resolved);
      const finalCatalogs = resolved ?? catalogs;
      const targets = request.provider
        ? [request.provider]
        : reported.map((runtime) => runtime.provider);
      await reply({
        accepted: true,
        results: targets.map((provider): ProviderModelRefreshResult => {
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
        }),
      });
    } catch {
      if (this.ports.isLive(transport)) {
        await reply({ accepted: false, results: [] }).catch(() => {});
      }
    }
  }
}
