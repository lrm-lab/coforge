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
import type { DaemonConnectionClient } from "#src/connection/daemon-connection";

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
 * when the inventory is first reported (ready or reconnect), when the inventory's login-capable
 * providers change, after a login or logout, and when a usage scan found the login gone. Every
 * call is fire-and-forget for the caller's purposes; a failed report is only a debug log.
 */
export class RuntimeAuthReporter {
  readonly #collector: RuntimeAuthStatusCollector;
  /** The login-capable providers the last inventory held; undefined until one is known. */
  #installed: ReadonlySet<RuntimeAuthProvider> | undefined;

  constructor(ports: Ports) {
    const createAdapter = ports.createAdapter ?? createRuntimeAuthAdapter;
    this.#collector = new RuntimeAuthStatusCollector({
      installedProviders: async () => [...(this.#installed ?? [])],
      readStatus: (provider) =>
        createAdapter(provider).readStatus({ workingDirectory: ports.workingDirectory }),
      report: async ({ collectedAtMs, runtimes }) => {
        if (ports.isStopping()) return;
        await ports.transport().reportRuntimeAuthStatus?.({
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
    this.#installed = loginCapable(runtimes);
    return this.refresh();
  }

  /** A later inventory discovery: report if it is the first one known or its login-capable providers changed. */
  inventoryObserved(runtimes: readonly RuntimeMetadata[]): void {
    const before = this.#installed;
    const after = loginCapable(runtimes);
    this.#installed = after;
    if (!before || !sameSet(before, after)) void this.refresh();
  }

  /** A usage scan answered; `reauth` for a login-capable provider means its login is gone. */
  usageScanned(provider: string, status: UsageScanResponse["status"]): void {
    if (status === "reauth" && isRuntimeAuthProvider(provider)) void this.refresh();
  }
}

function loginCapable(runtimes: readonly RuntimeMetadata[]): ReadonlySet<RuntimeAuthProvider> {
  return new Set(RUNTIME_AUTH_PROVIDERS.filter((p) => runtimes.some((r) => r.provider === p)));
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...a].every((value) => b.has(value));
}
