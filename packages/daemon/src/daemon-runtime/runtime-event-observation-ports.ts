import type { AgentActivity } from "@lrm/coforge-sdk/internal";
import type { UsageSnapshot } from "@lrm/coforge-anvil";
import type { AgentSessions } from "#src/agent-runtime/agent-session";
import type { ActivityLaunch } from "./activity-launch";
import type { ActivityDraft, PublishedActivityLaunch } from "./agent-activity-publisher";
import type { AgentActivityPublisher } from "./agent-activity-publisher";
import type { AgentDeliveryQueue } from "./agent-delivery-queue";
import type { AgentOfflineResidency } from "./agent-offline-residency";
import type { AgentUsageReport } from "./agent-usage-report";
import type { MentionDeliveryTracker } from "./mention-delivery-tracker";
import type { PhaseBookkeeping } from "./phase-bookkeeping";
import type { RuntimeErrorDeliveryHold } from "./runtime-error-delivery-hold";
import type { SystemCleaner } from "#src/system-cleaner/system-cleaner";
import type { TaskIdleNudge } from "./task-idle-nudge";
import type { AgentConfigApply } from "./agent-config-apply";

export type Publish = (
  id: string,
  source: PublishedActivityLaunch,
  activity: ActivityDraft,
) => void;

/** Everything the observation reads or writes that belongs to the runtime: existing collaborators
 * pass through by reference, one-off helpers arrive as functions. No daemon state is copied. */
export type RuntimeEventObservationPorts = Readonly<{
  activityPublisher: AgentActivityPublisher<ActivityLaunch>;
  deliveryQueue: AgentDeliveryQueue;
  offlineResidency: AgentOfflineResidency;
  usageReport: AgentUsageReport;
  phaseBookkeeping: PhaseBookkeeping;
  runtimeErrorHold: RuntimeErrorDeliveryHold;
  mentionDeliveries: MentionDeliveryTracker;
  agentSessions: AgentSessions;
  systemCleaner: SystemCleaner;
  /** The task idle reminder, asked when an interrupted turn leaves the Agent idle. */
  idleNudge?: Pick<TaskIdleNudge, "maybeAsk">;
  /** A pushed configuration, applied when an interrupted or failed turn leaves the Agent idle. */
  configApply?: Pick<AgentConfigApply, "settle">;
  collectSkillAgents: ReadonlySet<string>;
  fastModeWarned: Set<string>;
  isWorking(agentId: string): boolean;
  activityDraft(
    agentId: string,
    detailKind: AgentActivity["detailKind"],
    level: AgentActivity["level"],
    detail: string,
    extra?: Partial<ActivityDraft>,
  ): ActivityDraft;
  runtimeErrorActivity(agentId: string, message: string): ActivityDraft;
  interruptedActivity(agentId: string): ActivityDraft;
  showQuietTurn(agentId: string, launch: ActivityLaunch, publish: Publish): void;
  reconcileIdleTurn(agentId: string, launch: ActivityLaunch): boolean;
  /** Writes the last-subagent wake notice as idle input; only providers that need it call it. */
  wakeFinishedSubagents?(agentId: string): void;
  rememberUsage(snapshot: UsageSnapshot): void;
  releaseTurnEndHolds(agentId: string): void;
  drainAppInboxNotices(agentId: string): Promise<void>;
  failCollectorRunningSlots(agentId: string, failureReason: string): Promise<void>;
}>;
