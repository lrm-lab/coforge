import { getLogger } from "@logtape/logtape";
import {
  diagnosticErrorCode,
  type DaemonRuntimeCommandCodeEffortReadRequest,
  type RuntimeProvider,
  type UsageScanResponse,
} from "@lrm/coforge-sdk/internal";
import type { ResetCreditConsumeResult } from "./reset-credit-consume";
import type { DaemonConnectionClient } from "#src/connection/daemon-connection-client";
import type { CodeAgentInventorySync } from "./code-agent-inventory-sync";
import type { RuntimeAuthReporter } from "./runtime-auth-reporter";
import type { AgentUsageScanResult, AgentUsageScanScope } from "./agent-usage-scan";

const logger = getLogger(["coforge", "daemon", "daemon-runtime"]);

/** What a Workspace runtime answers when the server asks about its providers. */
export type ProviderScans = {
  connection: { workspaceId: string; computerId: string };
  runtime: {
    scanUsage(provider: RuntimeProvider): Promise<UsageScanResponse>;
    scanAgentUsage?(scope: AgentUsageScanScope): Promise<AgentUsageScanResult | undefined>;
    /** Spends a reset credit and reads usage again. */
    consumeResetCredit(
      provider: RuntimeProvider,
      idempotencyKey: string,
    ): Promise<ResetCreditConsumeResult>;
  };
  /** The runtime's live transport, read when an answer is sent. */
  currentTransport: () => DaemonConnectionClient;
  isStopping: () => boolean;
  /** Re-reads authentication before the answered scan reaches the browser. */
  runtimeAuth: Pick<RuntimeAuthReporter, "usageScanned">;
  inventory: Pick<CodeAgentInventorySync, "refreshModels"> & {
    readCommandCodeEfforts?(
      request: DaemonRuntimeCommandCodeEffortReadRequest,
      transport: DaemonConnectionClient,
    ): Promise<void>;
  };
};

/**
 * Subscribes one connection's provider scans: usage, a reset credit attempt, model refresh, and
 * one Command Code effort read, each only for this Computer. Returns the unsubscribes for the runtime to keep.
 */
export function subscribeProviderScans(
  transport: DaemonConnectionClient,
  scans: ProviderScans,
): ((() => void) | undefined)[] {
  const { connection, runtime } = scans;
  return [
    transport.onUsageScan?.(async (request) => {
      if (
        request.computerId !== connection.computerId ||
        request.workspaceId !== connection.workspaceId
      )
        return;
      const { agentId, expectedRuntimeConfigRevision } = request;
      if (agentId !== undefined) {
        if (scans.isStopping() || expectedRuntimeConfigRevision === undefined) return;
        try {
          const reading = await runtime.scanAgentUsage?.({
            agentId,
            expectedRuntimeConfigRevision,
          });
          if (!reading || scans.isStopping()) return;
          const {
            protocolMajor,
            accepted,
            status,
            message,
            snapshotJson,
            effectiveRuntimeConfigRevision,
          } = reading;
          await transport.sendUsageScanResult?.({
            ...connection,
            protocolMajor,
            requestId: request.requestId,
            provider: request.provider,
            agentId,
            effectiveRuntimeConfigRevision,
            accepted,
            status,
            message,
            snapshotJson,
          });
        } catch (error) {
          logger.warning("Agent usage answer could not be delivered", {
            event: "daemon_runtime:agent_usage_answer_failed",
            error_code: diagnosticErrorCode(error),
          });
        }
        return;
      }
      let result = await runtime.scanUsage(request.provider);
      try {
        await scans.runtimeAuth.usageScanned(request.provider, result.status);
      } catch {
        result = {
          protocolMajor: result.protocolMajor,
          requestId: result.requestId,
          accepted: false,
          status: "error",
          message: "Runtime login status could not be refreshed",
        };
      }
      await scans.currentTransport().sendUsageScanResult?.({
        ...result,
        requestId: request.requestId,
        workspaceId: connection.workspaceId,
        computerId: connection.computerId,
        provider: request.provider,
      });
    }),
    transport.onResetCreditConsume?.(async (request) => {
      if (scans.isStopping() || request.computerId !== connection.computerId) return;
      // Called without being awaited: a rejection here would be unhandled and end the Daemon
      // child. A lost answer is the page's `unknown`, which keeps its key.
      try {
        const result = await runtime.consumeResetCredit(request.provider, request.idempotencyKey);
        await scans.currentTransport().sendResetCreditConsumeResult?.({
          protocolMajor: 1,
          requestId: request.requestId,
          workspaceId: connection.workspaceId,
          computerId: connection.computerId,
          provider: request.provider,
          ...result,
        });
      } catch (error) {
        logger.warning("Reset credit answer could not be delivered", {
          event: "daemon_runtime:reset_credit_answer_failed",
          provider: request.provider,
          error_code: diagnosticErrorCode(error),
        });
      }
    }),
    transport.onProviderModelRefresh?.(async (request) => {
      if (scans.isStopping() || request.computerId !== connection.computerId) return;
      await scans.inventory.refreshModels(request, transport);
    }),
    transport.onCommandCodeEffortRead?.(async (request) => {
      if (scans.isStopping() || request.computerId !== connection.computerId) return;
      await scans.inventory.readCommandCodeEfforts?.(request, transport);
    }),
  ];
}
