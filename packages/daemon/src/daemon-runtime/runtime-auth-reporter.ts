import {
  RUNTIME_AUTH_PROVIDERS,
  isRuntimeAuthProvider,
  type RuntimeAuthAdapter,
  type RuntimeAuthProvider,
} from "@lrm/coforge-anvil";
import {
  WORKSPACE_PROTOCOL_MAJOR,
  type RuntimeMetadata,
  type UsageScanResponse,
} from "@lrm/coforge-sdk/internal";
import { createRuntimeAuthAdapter } from "#src/code-agent/registry";
import { RuntimeAuthStatusCollector } from "#src/code-agent/runtime-auth-status";
import type { DaemonConnectionClient } from "#src/connection/daemon-connection-client";

type Ports = {
  owner: { workspaceId: string; computerId: string };
  /** Where an adapter reads its status from. */
  workingDirectory: string;
  /** The runtime's current transport, read at send time. */
  transport: () => DaemonConnectionClient;
  isStopping: () => boolean;
  createAdapter?: (provider: RuntimeAuthProvider) => RuntimeAuthAdapter;
};

/**
 * Reports this Workspace runtime's login status to the cloud. It never polls: its owner calls it
 * when an inventory is reported or re-discovered, after a login or logout, and when a usage scan
 * answered. Callers may await collection and reporting; a failed report is logged at info.
 */
export class RuntimeAuthReporter {
  readonly #collector: RuntimeAuthStatusCollector;
  readonly #adapters = new Map<RuntimeAuthProvider, RuntimeAuthAdapter>();
  /** The providers with an auth-status surface the last inventory held; undefined until one is known. */
  #installed: ReadonlySet<RuntimeAuthProvider> | undefined;

  constructor(ports: Ports) {
    const createAdapter = ports.createAdapter ?? createRuntimeAuthAdapter;
    this.#collector = new RuntimeAuthStatusCollector({
      installedProviders: async () => [...(this.#installed ?? [])],
      readStatus: (provider) => {
        let adapter = this.#adapters.get(provider);
        if (!adapter) {
          adapter = createAdapter(provider);
          this.#adapters.set(provider, adapter);
        }
        return adapter.readStatus({ workingDirectory: ports.workingDirectory });
      },
      report: async ({ collectedAtMs, runtimes }) => {
        const transport = ports.transport();
        if (ports.isStopping() || !transport.reportRuntimeAuthStatus)
          throw new Error("Runtime login status reporting unavailable");
        await transport.reportRuntimeAuthStatus({
          protocolMajor: WORKSPACE_PROTOCOL_MAJOR,
          requestId: crypto.randomUUID(),
          ...ports.owner,
          collectedAtMs,
          runtimes,
        });
      },
    });
  }

  /** Reads and reports every runtime's status again. Nothing is reported before an inventory is known. */
  refresh(): Promise<void> {
    return this.#installed ? this.#collector.refresh() : Promise.resolve();
  }

  /** The inventory report just resolved (ready or reconnect): remember its providers and report. */
  inventoryReported(runtimes: readonly RuntimeMetadata[]): Promise<void> {
    this.#adapters.clear();
    this.#installed = loginCapable(runtimes);
    return this.refresh();
  }

  /** Every re-discovery re-reads auth: an unchanged provider list can hide a new executable or environment. */
  inventoryObserved(runtimes: readonly RuntimeMetadata[]): Promise<void> {
    this.#adapters.clear();
    this.#installed = loginCapable(runtimes);
    return this.refresh();
  }

  /** Every scan re-reads authentication independently of usage support or its result. */
  usageScanned(provider: string, _status: UsageScanResponse["status"]): Promise<void> {
    if (!isRuntimeAuthProvider(provider)) return Promise.resolve();
    if (!this.#installed) return Promise.reject(new Error("Runtime inventory unavailable"));
    return this.#collector.refresh({ requireReport: true });
  }
}

function loginCapable(runtimes: readonly RuntimeMetadata[]): ReadonlySet<RuntimeAuthProvider> {
  return new Set(RUNTIME_AUTH_PROVIDERS.filter((p) => runtimes.some((r) => r.provider === p)));
}
