import type { AgentMessageAttentionIndex } from "./agent-message-attention-index";
import type { AgentInputDrain } from "./agent-input-drain";
import type { AgentProcessManager, AgentRuntime } from "#src/agent-runtime/agent-process-manager";
import type { AgentDeliveryGate } from "./agent-delivery-gate";
import type { AgentOfflineResidency } from "./agent-offline-residency";
import type { ActivityLaunch } from "./activity-launch";
import type { AgentActivityPublisher } from "./agent-activity-publisher";
import type { RuntimeErrorDeliveryHold } from "./runtime-error-delivery-hold";
import { createAgentDesktopHolds } from "#src/agent-runtime/agent-desktop";
import { AgentProcessCleanupError } from "@lrm/coforge-anvil";
import { logAgentApiKeyRevokeFailed } from "./agent-failure-logs";
import {
  agentLaunchTagToken,
  clearAgentLaunchTag,
  sweepAgentLaunchTagStrays,
} from "./agent-launch-tags";

export type AgentStopCoordinatorPorts = {
  agentLaunches: Map<string, Promise<AgentRuntime>>;
  currentActivityLaunches: Map<string, ActivityLaunch>;
  inputDrain: AgentInputDrain;
  processManager: AgentProcessManager;
  activityPublisher: AgentActivityPublisher<ActivityLaunch>;
  desktops: ReturnType<typeof createAgentDesktopHolds>;
  agentApiKeys: Map<string, string>;
  revokeAgentApiKey: (agentId: string, apiKey: string | undefined, scope?: "all") => Promise<void>;
  messageAttention: AgentMessageAttentionIndex;
  deliveryGate: AgentDeliveryGate;
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
      .revokeAgentApiKey(agentId, this.ports.agentApiKeys.get(agentId), "all")
      .catch((error) => {
        logAgentApiKeyRevokeFailed(agentId, error);
      });
    await this.ports.processManager.stop(agentId);
    // Descendants that escaped the process-tree cleanup still carry launch tags from every
    // launch this Agent ran; embedded providers have no process-exit event to sweep from, so
    // the stop path collects them here (task #673). The sweep is Agent-scoped — a deliberate
    // Stop ends every launch's strays, including one already in flight: only a launch that
    // registers its token after this clear is spared. It runs even with no registered
    // token: the exited launch's own handler clears the registry before this point.
    const stoppedTagToken = agentLaunchTagToken(agentId);
    if (stoppedTagToken !== undefined) clearAgentLaunchTag(agentId, stoppedTagToken);
    sweepAgentLaunchTagStrays(agentId, "stop");
    this.ports.messageAttention.clearAgent(agentId);
    this.ports.deliveryGate.clearAgent(agentId);
    this.ports.runtimeErrorHold.forget(agentId);
    // A quota launch is waiting out a recovery time. Reporting inactive here is what makes the
    // card look offline; the retry stays armed on the control record. Read the wait before
    // `forget`, which clears it so a later explicit Stop still reports inactive.
    const waitingForQuota = this.ports.offlineResidency.hasLaunchWait(agentId);
    this.ports.offlineResidency.forget(agentId);
    if (!waitingForQuota) this.ports.sendAgentStatus(agentId, "inactive");
    this.ports.activityPublisher.forgetBusy(agentId);
    if (!retainLaunch) this.ports.currentActivityLaunches.delete(agentId);
  }
}
