import type { ActivityTrajectory } from "#src/agent-runtime/activity-trajectory";
import type { AgentStartup } from "#src/agent-runtime/agent-startup";
import type { RuntimeErrorClassFence } from "#src/agent-runtime/runtime-error-recovery";
import type {
  buildRuntimeErrorActivity,
  RuntimeErrorEvent,
} from "#src/agent-runtime/runtime-error-activity";
import type {
  OutstandingBackgroundTasks,
  SubagentWakeTracker,
} from "#src/agent-runtime/subagent-progress-activity";
import type { ToolCallLedger } from "#src/agent-runtime/tool-call-ledger";
import type { TurnEvidenceLedger } from "#src/agent-runtime/turn-evidence";
import type { PublishedActivityLaunch } from "./agent-activity-publisher";
import type { ReplyIntentTracker } from "./reply-intent-tracker";
import type { ProviderProgress } from "./stalled-recovery";
import type { StalledTurnTracker } from "./stalled-turn-indicator";
import type { LaunchPhaseTiming } from "./launch-phase-timing";
import type { ClaudeModelQuotaLaunch } from "./claude-model-quota-holds";

export type ActivityLaunch = PublishedActivityLaunch & {
  modelQuotaInputHeld?: true;
  resumeModelQuotaInput?: ClaudeModelQuotaLaunch["resumeModelQuotaInput"];
  model?: string;
  flushTokenUsage?: (conversationId?: string) => boolean;
  startup?: AgentStartup;
  startupAbort?: AbortController;
  trajectory?: Pick<ActivityTrajectory, "flush" | "dispose">;
  progress?: ProviderProgress;
  timing?: LaunchPhaseTiming;
  toolCalls?: ToolCallLedger;
  turnEvidence?: TurnEvidenceLedger;
  idleCompaction?: boolean;
  lastContextTokens?: number;
  stalled?: StalledTurnTracker;
  replyIntents?: ReplyIntentTracker;
  backgroundTasks?: OutstandingBackgroundTasks;
  subagentWake?: SubagentWakeTracker;
  lastTurnInterrupted?: boolean;
  crashDetail?: RuntimeErrorEvent;
  runtimeErrorClassFence?: RuntimeErrorClassFence;
  offlineError?: ReturnType<typeof buildRuntimeErrorActivity>;
};
