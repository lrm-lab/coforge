import type { AgentMessageAttentionIndex } from "./agent-message-attention-index";
import type { AgentInputDrain } from "./agent-input-drain";
import type { AgentProcessManager, AgentRuntime } from "#src/agent-runtime/agent-process-manager";
import type { AgentDeliveryQueue } from "./agent-delivery-queue";
import type { AgentOfflineResidency } from "./agent-offline-residency";
import type { ActivityLaunch } from "./activity-launch";
import type { AgentActivityPublisher } from "./agent-activity-publisher";
import type { RuntimeErrorDeliveryHold } from "./runtime-error-delivery-hold";
import { createAgentDesktopHolds } from "#src/agent-runtime/agent-desktop";
import { AgentProcessCleanupError } from "@lrm/coforge-anvil";
import { logAgentApiKeyRevokeFailed } from "./agent-failure-logs";

export type AgentStopCoordinatorPorts = {
  agentLaunches: Map<string, Promise<AgentRuntime>>;
  currentActivityLaunches: Map<string, ActivityLaunch>;
  inputDrain: AgentInputDrain;
  processManager: AgentProcessManager;
  activityPublisher: AgentActivityPublisher<ActivityLaunch>;
  desktops: ReturnType<typeof createAgentDesktopHolds>;
  agentApiKeys: Map<string, string>;
  revokeAgentApiKey: (agentId: string, apiKey: string | undefined) => Promise<void>;
  messageAttention: AgentMessageAttentionIndex;
  deliveryQueue: AgentDeliveryQueue;
  runtimeErrorHold: RuntimeErrorDeliveryHold;
  offlineResidency: AgentOfflineResidency;
  sendAgentStatus: (agentId: string, status: "active" | "inactive") => void;
  publishStopped: (agentId: string, launch: ActivityLaunch) => void;
};

/** Owns process release and stop ordering after DaemonRuntime has closed admission. */
export class AgentStopCoordinator {
  constructor(private readonly ports: AgentStopCoordinatorPorts) {}

  async stopAgent(agentId: string): Promise<void> {
    const launch = this.ports.agentLaunches.get(agentId);
    const activityLaunch = this.ports.currentActivityLaunches.get(agentId);
    const inputDrain = this.ports.inputDrain.get(agentId)?.drain;
    // Disposal rejects input waiting for a native turn boundary. Waiting for that input (or
    // launch recovery using it) first would prevent the very disposal that releases it.
    await this.releaseAgentRuntime(agentId, { retainLaunch: true });
    if (launch) await Promise.allSettled([launch]);
    // A provider still creating its session at Stop may register and fail cleanup afterwards.
    if (this.ports.processManager.isStopping(agentId)) throw new AgentProcessCleanupError();
    await this.ports.processManager.stop(agentId);
    if (inputDrain) await Promise.allSettled([inputDrain]);
    if (activityLaunch) this.ports.publishStopped(agentId, activityLaunch);
    this.ports.currentActivityLaunches.delete(agentId);
  }

  /** Stop's outcome depends only on local process exit; key revoke is best effort alongside it. */
  async releaseAgentRuntime(
    agentId: string,
    { retainLaunch = false }: { retainLaunch?: boolean } = {},
  ): Promise<void> {
    const activityLaunch = this.ports.currentActivityLaunches.get(agentId);
    this.ports.desktops.end(agentId);
    activityLaunch?.startup?.dispose();
    void this.ports
      .revokeAgentApiKey(agentId, this.ports.agentApiKeys.get(agentId))
      .catch((error) => {
        logAgentApiKeyRevokeFailed(agentId, error);
      });
    await this.ports.processManager.stop(agentId);
    this.ports.messageAttention.clearAgent(agentId);
    this.ports.deliveryQueue.clearAgent(agentId);
    this.ports.runtimeErrorHold.forget(agentId);
    this.ports.offlineResidency.forget(agentId);
    this.ports.sendAgentStatus(agentId, "inactive");
    this.ports.activityPublisher.forgetBusy(agentId);
    if (!retainLaunch) this.ports.currentActivityLaunches.delete(agentId);
  }
}
