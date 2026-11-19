import type { AgentActivity, RuntimeProvider } from "@lrm/coforge-sdk/internal";
import type { UsageSnapshot } from "@lrm/coforge-anvil";
import type { AgentSessions } from "#src/agent-runtime/agent-session";
import type { ActivityLaunch } from "./activity-launch";
import type { ActivityDraft, PublishedActivityLaunch } from "./agent-activity-publisher";
import type { AgentActivityPublisher } from "./agent-activity-publisher";
import type { AgentDeliveryGate } from "./agent-delivery-gate";
import type { AgentOfflineResidency } from "./agent-offline-residency";
import type { AgentUsageReport } from "./agent-usage-report";
import type { MentionDeliveryTracker } from "./mention-delivery-tracker";
import type { PhaseBookkeeping } from "./phase-bookkeeping";
import type { CredentialInvalidHolds } from "./credential-invalid-holds";
import type { RuntimeErrorDeliveryHold } from "./runtime-error-delivery-hold";
import type { SystemCleaner } from "#src/system-cleaner/system-cleaner";
import type { TaskIdleNudge } from "./task-idle-nudge";
import type { AgentConfigApply } from "./agent-config-apply";

export type Publish = (
  id: string,
  source: PublishedActivityLaunch,
  activity: ActivityDraft,
) => void;

export type SessionSummaryObserver = Readonly<{
  contextUsage(
    agentId: string,
    provider: RuntimeProvider,
    usedTokens: number,
    windowTokens: number,
    occurredAt?: string,
  ): void;
  compaction(
    agentId: string,
    provider: RuntimeProvider,
    tokensAfter?: number,
    windowTokens?: number,
  ): void;
  turnCompleted(agentId: string, provider: RuntimeProvider): void;
}>;

export type RuntimeEventObservationPorts = Readonly<{
  activityPublisher: AgentActivityPublisher<ActivityLaunch>;
  deliveryGate: AgentDeliveryGate;
  offlineResidency: AgentOfflineResidency;
  usageReport: AgentUsageReport;
  phaseBookkeeping: PhaseBookkeeping;
  runtimeErrorHold: RuntimeErrorDeliveryHold;
  credentialHolds: Pick<CredentialInvalidHolds, "record">;
  mentionDeliveries: MentionDeliveryTracker;
  agentSessions: AgentSessions;
  systemCleaner: SystemCleaner;
  idleNudge?: Pick<TaskIdleNudge, "maybeAsk">;
  configApply?: Pick<AgentConfigApply, "settle">;
  sessionSummary?: SessionSummaryObserver;
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
  wakeFinishedSubagents?(agentId: string): void;
  rememberUsage(snapshot: UsageSnapshot): void;
  releaseTurnEndHolds(agentId: string): void;
  drainAppInboxNotices(agentId: string): Promise<void>;
  failCollectorRunningSlots(agentId: string, failureReason: string): Promise<void>;
}>;
