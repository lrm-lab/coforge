import {
  AGENT_ACTIVITY_DETAIL_KIND,
  type AgentActivity,
  type AgentMessageDelivery,
} from "@lrm/coforge-sdk/internal";
import { diagnosticErrorName } from "@lrm/coforge-sdk/internal";
import type { ActivityLaunch } from "./activity-launch";
import type { ActivityDraft, AgentActivityPublisher } from "./agent-activity-publisher";
import type { AgentDeliveryQueue } from "./agent-delivery-queue";
import type { AgentInboxCoordinator } from "./agent-inbox-coordinator";
import type { TaskIdleNudge } from "./task-idle-nudge";
import type { AgentLaunchCustody } from "./agent-launch-custody";
import type { AgentMessageAttentionIndex } from "./agent-message-attention-index";
import type { AgentProcessManager } from "#src/agent-runtime/agent-process-manager";
import type { PhaseBookkeeping } from "./phase-bookkeeping";
import type { RuntimeRelease } from "./runtime-release";
import type { SystemCleaner } from "#src/system-cleaner/system-cleaner";
import { getLogger } from "@logtape/logtape";

const logger = getLogger(["coforge", "daemon", "runtime"]);
type Drafts = ReturnType<typeof import("./agent-activity-drafts").agentActivityDrafts>;

export type RuntimeTurnPorts = {
  messageAttention: AgentMessageAttentionIndex;
  activityPublisher: AgentActivityPublisher<ActivityLaunch>;
  deliveryQueue: AgentDeliveryQueue;
  inboxCoordinator: AgentInboxCoordinator;
  launchCustody: AgentLaunchCustody;
  processManager: AgentProcessManager;
  currentActivityLaunches: Map<string, ActivityLaunch>;
  phaseBookkeeping: PhaseBookkeeping;
  runtimeRelease: RuntimeRelease<ActivityLaunch>;
  systemCleaner: SystemCleaner;
  /** The task idle reminder, asked when a turn leaves the Agent idle. */
  idleNudge?: Pick<TaskIdleNudge, "maybeAsk">;
  drafts: Drafts;
  activity(
    agentId: string,
    kind: AgentActivity["detailKind"],
    level: AgentActivity["level"],
    detail: string,
    extra?: Partial<ActivityDraft>,
  ): ActivityDraft;
  isWorking(agentId: string): boolean;
};

/** Attempts delivery of everything just released from an explicit or busy-gated hold, as one
 * coalesced notice — never blocking the caller on it. Shared by ordinary turn-end draining and
 * the runtime-error delivery backoff. */
export function flushHeldDeliveries(
  ports: RuntimeTurnPorts,
  agentId: string,
  held: AgentMessageDelivery[],
): void {
  void ports.messageAttention.flush(agentId, held).catch((error: unknown) => {
    logger.warn("Held Agent deliveries were not accepted", {
      event: "agent.delivery_queue.flush_rejected",
      agent_id: agentId,
      held_count: held.length,
      already_acknowledged: true,
      error_code: diagnosticErrorName(error),
    });
  });
}

/** Reports runtime_interrupted when a requested stop/restart cuts a busy turn. Must run before
 * `forgetBusy`, which erases the busy evidence. */
export function interruptIfBusy(
  ports: RuntimeTurnPorts,
  agentId: string,
  launch: ActivityLaunch | undefined,
): void {
  if (!launch) return;
  const busy = ports.activityPublisher.lastBusy(agentId);
  if (busy && busy.launch === launch)
    ports.activityPublisher.publish(agentId, launch, ports.drafts.interrupted(agentId));
}

/** Shows a turn that ended without an error, as the reference client does: still working while
 * tasks it started run in the background, otherwise Idle, which ends the Agent's working stretch. */
export function showQuietTurn(
  ports: RuntimeTurnPorts,
  agentId: string,
  launch: ActivityLaunch,
  publish: (agentId: string, launch: ActivityLaunch, activity: ActivityDraft) => void,
): void {
  const waiting = launch.backgroundTasks?.quietDetail();
  publish(agentId, launch, ports.drafts.quietTurn(agentId, waiting));
  if (!waiting) {
    ports.systemCleaner.onAgentWorkingToIdle(agentId);
    ports.idleNudge?.maybeAsk(agentId);
  }
}

/** Restore observation and delivery gating only; this is no proof of a turn outcome. */
export function reconcileIdleTurn(
  ports: RuntimeTurnPorts,
  agentId: string,
  launch: ActivityLaunch,
): boolean {
  if (
    ports.currentActivityLaunches.get(agentId) !== launch ||
    ports.processManager.session(agentId)?.hasLiveTurn !== false
  )
    return false;
  // A turn already showing its wait for background tasks stays as it is: the heartbeat keeps
  // that warm until a task ends.
  const waiting = launch.backgroundTasks?.quietDetail();
  const shown = ports.activityPublisher.lastBusy(agentId)?.activity;
  if (
    waiting &&
    shown?.detailKind === AGENT_ACTIVITY_DETAIL_KIND.SUBAGENT_ACTIVITY &&
    shown.detail === waiting
  )
    return false;
  // Preserve output accepted while the turn was live before publishing its final Idle.
  // Otherwise the pending trajectory timer could publish it after Idle and rearm Busy.
  launch.trajectory?.flush();
  launch.stalled?.finish(agentId);
  ports.phaseBookkeeping.dispose(agentId);
  if (ports.isWorking(agentId)) {
    showQuietTurn(ports, agentId, launch, (id, source, activity) =>
      ports.activityPublisher.publish(id, source, activity),
    );
    releaseTurnEndHolds(ports, agentId);
  }
  return true;
}

/** Presents what was kept across an exit or a runtime's end, as at idle. */
export function releaseSurvivingHolds(ports: RuntimeTurnPorts, agentId: string): void {
  ports.launchCustody.flushSurvivingDeliveryQueue(agentId);
  ports.inboxCoordinator.releaseHeldAppItems(agentId);
  ports.inboxCoordinator.releaseFallbackNotices(agentId);
}

/** Whether the Agent is mid-turn, by its last busy Activity or a notice just written. */
export function isWorking(ports: RuntimeTurnPorts, agentId: string): boolean {
  return (
    ports.activityPublisher.lastBusy(agentId) !== undefined || ports.deliveryQueue.isBusy(agentId)
  );
}

export function releaseTurnEndHolds(ports: RuntimeTurnPorts, agentId: string): void {
  const held = ports.deliveryQueue.idle(agentId);
  if (held.length) flushHeldDeliveries(ports, agentId, held);
  // Flush first: notifying marks busy synchronously, so app items re-hold for the next
  // turn rather than racing the notice that just started it.
  ports.inboxCoordinator.releaseHeldAppItems(agentId);
  ports.inboxCoordinator.releaseFallbackNotices(agentId);
}

/** Narrates a daemon-initiated cold start: a stored session found unusable, or one recycled. */
export function narrateUnavailable(
  ports: RuntimeTurnPorts,
  agentId: string,
  launch: ActivityLaunch,
  detail: string,
  entryText?: string,
): void {
  ports.activityPublisher.publish(
    agentId,
    launch,
    ports.activity(
      agentId,
      AGENT_ACTIVITY_DETAIL_KIND.RUNTIME_UNAVAILABLE,
      "info",
      detail,
      entryText ? { entries: [{ kind: "text", text: entryText }] } : {},
    ),
  );
}
