import type {
  AgentContextScanRequest,
  AgentContextScanResponse,
  RuntimeProvider,
  UsageScanResponse,
} from "@lrm/coforge-sdk/internal";
import type { DaemonConnectionClient } from "#src/connection/daemon-connection";
import type { CodeAgentInventorySync } from "./code-agent-inventory-sync";
import type { RuntimeAuthReporter } from "./runtime-auth-reporter";

/** What a Workspace runtime answers when the server asks about its providers. */
export type ProviderScans = {
  connection: { workspaceId: string; computerId: string };
  runtime: {
    scanUsage(provider: RuntimeProvider): Promise<UsageScanResponse>;
    scanAgentContext(request: AgentContextScanRequest): Promise<AgentContextScanResponse>;
  };
  /** The runtime's live transport, read when an answer is sent. */
  currentTransport: () => DaemonConnectionClient;
  isStopping: () => boolean;
  /** Watches answered usage scans for `reauth`. */
  runtimeAuth: Pick<RuntimeAuthReporter, "usageScanned">;
  inventory: Pick<CodeAgentInventorySync, "refreshModels">;
};

/**
 * Subscribes one connection's provider scans: usage, model refresh and an Agent's context
 * window, each only for this Computer. Returns the unsubscribes for the runtime to keep.
 */
export function subscribeProviderScans(
  transport: DaemonConnectionClient,
  scans: ProviderScans,
): ((() => void) | undefined)[] {
  const { connection, runtime } = scans;
  return [
    transport.onUsageScan?.(async (request) => {
      if (request.computerId !== connection.computerId) return;
      const result = await runtime.scanUsage(request.provider);
      scans.runtimeAuth.usageScanned(request.provider, result.status);
      await scans.currentTransport().sendUsageScanResult?.({
        ...result,
        requestId: request.requestId,
        workspaceId: connection.workspaceId,
        computerId: connection.computerId,
        provider: request.provider,
      });
    }),
    transport.onProviderModelRefresh?.(async (request) => {
      if (scans.isStopping() || request.computerId !== connection.computerId) return;
      await scans.inventory.refreshModels(request, transport);
    }),
    transport.onAgentContextScan?.(async (request) => {
      if (request.computerId !== connection.computerId) return;
      const result = await runtime.scanAgentContext(request);
      await scans.currentTransport().sendAgentContextScanResult?.(result);
    }),
  ];
}
