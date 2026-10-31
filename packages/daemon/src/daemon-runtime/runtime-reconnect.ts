import { diagnosticErrorCode } from "@lrm/coforge-sdk/internal";
import { getLogger } from "@logtape/logtape";
import type { DaemonConnectionClient } from "#src/connection/daemon-connection-client";

const logger = getLogger(["coforge", "daemon", "runtime"]);

export type RuntimeReconnectPorts = {
  workspaceId: string;
  computerId: string;
  refreshInventory: (transport: DaemonConnectionClient) => void;
  runningAgentIds: () => string[];
  requestReminderSnapshot: (agentId: string) => Promise<void>;
  resyncAppConfigs: () => void;
  replayAgentControl: () => Promise<void>;
  replayAgentSessions: () => Promise<void>;
  reportUpgradeResults: () => Promise<void>;
};

/** Installs the reconnect recovery pass for one live daemon connection. */
export function subscribeRuntimeReconnect(
  transport: DaemonConnectionClient,
  ports: RuntimeReconnectPorts,
): (() => void) | undefined {
  return transport.onReconnect?.(() => {
    ports.refreshInventory(transport);
    for (const agentId of ports.runningAgentIds())
      void ports.requestReminderSnapshot(agentId).catch(() => {});
    ports.resyncAppConfigs();
    void ports
      .replayAgentControl()
      .then(() => ports.replayAgentSessions())
      .catch((error) => {
        logger.warning("Agent control recovery replay failed", {
          event: "agent_control:replay_failed",
          workspace_id: ports.workspaceId,
          computer_id: ports.computerId,
          error_code: diagnosticErrorCode(error),
          outcome: "failed",
        });
      });
    // A result whose send failed while disconnected, or one settled meanwhile.
    void ports.reportUpgradeResults();
  });
}
