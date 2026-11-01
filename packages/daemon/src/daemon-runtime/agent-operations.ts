import { getLogger } from "@logtape/logtape";
import {
  AGENT_ACTIVITY_DETAIL_KIND,
  MENTION_DELIVERY_TERMINAL_CODES,
  diagnosticErrorName,
  type AgentActivity,
  type AgentActivityProbe,
  type AgentInboxPurge,
  type AgentMessageResponse,
  type LocalAgentMessageRequest,
} from "@lrm/coforge-sdk/internal";
import type { DaemonConnectionClient } from "#src/connection/daemon-connection-client";
import type { AgentProcessManager } from "#src/agent-runtime/agent-process-manager";
import type { ActivityDraft, AgentActivityPublisher } from "./agent-activity-publisher";
import type { agentActivityDrafts } from "./agent-activity-drafts";
import type { AgentDeliveryQueue } from "./agent-delivery-queue";
import type { AgentInputDrain } from "./agent-input-drain";
import type { AgentLaunchCustody } from "./agent-launch-custody";
import type { AgentMessageAttentionIndex } from "./agent-message-attention-index";
import type { AgentMessageOperations } from "./agent-message-operations";
import type { AgentStopCoordinator } from "./agent-stop-coordinator";
import type { ActivityLaunch } from "./activity-launch";
import type { MentionDeliveryTracker } from "./mention-delivery-tracker";
import type { DaemonConfig } from "./runtime";
import type { AgentStopRegistry } from "./agent-stop-registry";

import { AgentPreflightError } from "./agent-preflight-error";
import { isAgentApiKey } from "#src/credentials/agent-api-key";
import { stopFailureMessage } from "./agent-failure-presentation";

const logger = getLogger(["coforge", "daemon", "runtime"]);

/** What the runtime supplies to the cloud-facing Agent operations it answers. */
export type AgentOperationsPorts = {
  connection: Pick<DaemonConfig, "workspaceId">;
  /** The Workspace's current transport, read at call time. */
  transport(): DaemonConnectionClient;
  assertRunning(): void;
  /** Refuses a probe another Computer or Workspace sent. */
  assertOwnIntent(probe: AgentActivityProbe): void;
  agentIdForContext(context: string): string;
  /** The canonical target a spelled one belongs to, as a read already mapped it. */
  canonicalAgentMessageTarget(
    agentId: string,
    target: string,
    agentApiKey: string,
  ): Promise<string>;
  currentActivityLaunch(agentId: string): ActivityLaunch | undefined;
  activityPublisher: AgentActivityPublisher<ActivityLaunch>;
  drafts: ReturnType<typeof agentActivityDrafts>;
  activity(
    agentId: string,
    detailKind: AgentActivity["detailKind"],
    level: AgentActivity["level"],
    detail: string,
    extra?: Partial<ActivityDraft>,
  ): ActivityDraft;
  messageAttention: AgentMessageAttentionIndex;
  deliveryQueue: AgentDeliveryQueue;
  inputDrain: AgentInputDrain;
  mentionDeliveries: MentionDeliveryTracker;
  launchCustody: Pick<AgentLaunchCustody, "acknowledge">;
  processManager: AgentProcessManager;
  /** Which Agents are stopping and which Session each launch reported. */
  stops: Pick<AgentStopRegistry, "pendingStop" | "beginStop" | "trackStop" | "settleStop">;
  interruptIfBusy(agentId: string, launch: ActivityLaunch | undefined): void;
  disposeLaunchObservations(agentId: string): void;
  revokeLocalLaunch(agentId: string): void;
  stopCoordinator: Pick<AgentStopCoordinator, "stopAgent">;
  cleanupUnconfirmed(agentId: string, error: unknown): boolean;
  messageOperations: Pick<AgentMessageOperations, "handle">;
};

/**
 * The cloud-facing Agent operations one runtime answers: an activity probe, an inbox purge for
 * channels the Agent can no longer read, one Agent's stop, and the Agent's own message operation.
 * `DaemonRuntime` supplies the collaborators each one calls.
 */
export class AgentOperations {
  constructor(private readonly ports: AgentOperationsPorts) {}

  async handleActivityProbe(probe: AgentActivityProbe): Promise<void> {
    const { ports } = this;
    ports.assertOwnIntent(probe);
    const launch = ports.currentActivityLaunch(probe.agentId);
    if (!launch) {
      logger.info("Activity probe received for an Agent that is not running", {
        event: "agent_activity_probe:not_running",
        request_id: probe.requestId,
        workspace_id: probe.workspaceId,
        computer_id: probe.computerId,
        agent_id: probe.agentId,
        probe_id: probe.probeId,
        outcome: "skipped",
      });
      return;
    }
    const unread = ports.messageAttention.unreadDeliveries(probe.agentId);
    const hold = ports.deliveryQueue.explicitHold(probe.agentId);
    if (unread.length && hold !== "fingerprint_fence") {
      logger.info("Activity probe answered for an Agent with unread messages", {
        event: "agent_activity_probe:pending_delivery",
        request_id: probe.requestId,
        workspace_id: probe.workspaceId,
        computer_id: probe.computerId,
        agent_id: probe.agentId,
        probe_id: probe.probeId,
        launch_id: launch.launchId,
        target_count: unread.length,
        message_count: unread.reduce((sum, target) => sum + target.count, 0),
        ...(hold ? { hold_reason: hold } : {}),
      });
      ports.activityPublisher.publish(probe.agentId, launch, {
        ...ports.activity(
          probe.agentId,
          AGENT_ACTIVITY_DETAIL_KIND.MESSAGE_RECEIVED,
          "info",
          "Message received",
          { entries: [] },
        ),
        probeId: probe.probeId,
      });
      return;
    }
    const remembered = ports.activityPublisher.lastBusy(probe.agentId);
    if (launch.startup?.waiting) {
      ports.activityPublisher.publish(probe.agentId, launch, {
        ...ports.drafts.starting(probe.agentId),
        probeId: probe.probeId,
      });
      return;
    }
    if (remembered && remembered.launch === launch) {
      ports.activityPublisher.publish(probe.agentId, launch, {
        ...remembered.activity,
        probeId: probe.probeId,
        entries: [],
        isHeartbeat: false,
      });
      return;
    }
    ports.activityPublisher.publish(probe.agentId, launch, {
      ...ports.drafts.idle(probe.agentId),
      probeId: probe.probeId,
    });
  }

  handleInboxPurge(purge: AgentInboxPurge): void {
    const { ports } = this;
    ports.assertRunning();
    if (purge.workspaceId !== ports.connection.workspaceId)
      throw new Error("agent inbox purge targets another Workspace");
    const conversations = new Set(purge.conversationIds);
    const session = ports.processManager.session(purge.agentId);
    for (const conversationId of conversations)
      void session?.purgeConversation?.(conversationId).catch((error) => {
        logger.warning("Memory conversation cleanup failed", {
          event: "agent.inbox.purge_cleanup_failed",
          agent_id: purge.agentId,
          error_code: diagnosticErrorName(error),
        });
      });
    let dropped = 0;
    const queue = ports.inputDrain.get(purge.agentId);
    if (queue)
      queue.items = queue.items.filter((item) => {
        if (item.kind !== "delivery" || !conversations.has(item.message.conversationId))
          return true;
        // Taken and dropped: acknowledged, so the server does not bring it back after a rejoin. A
        // tracked mention is never ACKed untold: the Agent will not be told it, so it is rejected.
        if (
          !ports.mentionDeliveries.drop(
            item.message,
            MENTION_DELIVERY_TERMINAL_CODES.DELIVERY_REJECTED,
          )
        )
          ports.launchCustody.acknowledge(item.message);
        item.completion.resolve();
        dropped++;
        return false;
      });
    dropped += ports.deliveryQueue.discardConversations(purge.agentId, conversations).length;
    ports.messageAttention.clearTargets(purge.agentId, purge.targets);
    logger.info("Agent inbox purged for channels it can no longer read", {
      event: "agent.inbox.purged",
      agent_id: purge.agentId,
      reason: purge.reason,
      conversation_count: conversations.size,
      dropped_delivery_count: dropped,
    });
  }

  stopAgent(agentId: string): Promise<void> {
    const { ports } = this;
    const existingStop = ports.stops.pendingStop(agentId);
    if (existingStop) return existingStop;
    // Close this Agent's launch gate and local capabilities before the first await.
    ports.stops.beginStop(agentId);
    ports.inputDrain.close(agentId, new Error(`Agent runtime is stopping: ${agentId}`));
    // Invalidate acceptance before disposal: a late native reply cannot acknowledge a cancelled
    // delivery or attach its attention to the replacement session.
    ports.messageAttention.clearAgent(agentId, { cancelNotices: true });
    void ports.mentionDeliveries.cancelAgent(agentId);
    ports.processManager.session(agentId)?.cancelPendingNotices?.();
    const activityLaunch = ports.currentActivityLaunch(agentId);
    activityLaunch?.startup?.dispose();
    if (activityLaunch) activityLaunch.stopping = true;
    ports.interruptIfBusy(agentId, activityLaunch);
    ports.activityPublisher.forgetBusy(agentId);
    ports.disposeLaunchObservations(agentId);
    ports.revokeLocalLaunch(agentId);
    const stopping = ports.stopCoordinator
      .stopAgent(agentId)
      .catch((error) => {
        if (activityLaunch)
          ports.activityPublisher.publish(
            agentId,
            activityLaunch,
            ports.drafts.runtimeError(
              agentId,
              stopFailureMessage(ports.cleanupUnconfirmed(agentId, error)),
            ),
          );
        throw error;
      })
      .finally(() => {
        ports.stops.settleStop(agentId, ports.processManager.isStopping(agentId));
      });
    ports.stops.trackStop(agentId, stopping);
    return stopping;
  }

  async agentMessage(
    context: string,
    request: LocalAgentMessageRequest,
    agentApiKey: string,
  ): Promise<AgentMessageResponse> {
    const { ports } = this;
    ports.assertRunning();
    const agentId = ports.agentIdForContext(context);
    if (!ports.transport().agentMessage)
      throw new AgentPreflightError("daemon connection is not connected", "DAEMON_NOT_CONNECTED");
    if (!isAgentApiKey(agentApiKey))
      throw new AgentPreflightError("Agent API key is missing", "AGENT_API_KEY_MISSING");
    logger.info("Agent message operation received", {
      event: "agent.message.operation",
      agent_id: agentId,
      operation: request.operation,
      target: request.target ?? "*",
    });
    // A spelling a read has already mapped to its canonical target shares that target's state.
    const target = request.target
      ? ports.messageAttention.resolveTarget(
          agentId,
          await ports.canonicalAgentMessageTarget(agentId, request.target, agentApiKey),
        )
      : undefined;
    return ports.messageOperations.handle(agentId, request, target, agentApiKey);
  }
}
