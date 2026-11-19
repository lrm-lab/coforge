import type {
  RuntimeProvider,
  RuntimeErrorAction,
  ActivityTrajectoryEntry,
  ActivitySubagent,
  AgentActivityDetailKind,
  AgentServiceTierObserved,
} from "@lrm/coforge-sdk/internal";
export type AgentActivityLevel = "info" | "warning" | "error";
export type AgentSubagentTaskKind = "command" | "agent" | "other";
export type AgentActivity = Readonly<{
  detailKind: AgentActivityDetailKind;
  level: AgentActivityLevel;
  detail: string;
  observedAtMs: number;
  entries?: ActivityTrajectoryEntry[];
  runtimeError?: Readonly<{
    errorClass: string;
    errorReason: string;
    fingerprint: string;
    requiredAction?: RuntimeErrorAction;
    providerMessage?: string;
  }>;
}>;
export type AgentRuntimeProviderConfig =
  | Readonly<{
      kind: "default";
    }>
  | Readonly<{
      kind: "coforge";
      providerId: string;
      apiKey?: string;
    }>;
export type AgentRuntimeConfig = Readonly<{
  provider: RuntimeProvider;
  model: string;
  modelProvider?: string;
  reasoning: string;
  providerConfig?: AgentRuntimeProviderConfig;
  fastMode?: boolean;
  contextWindow?: number;
  maxOutputTokens?: number;
  envVars?: Readonly<Record<string, string>>;
}>;
export type UsageWindowStatus = "ok" | "limit_reached" | "parse_unavailable";
export type UsageQuotaLevel = "ok" | "warning" | "near_exhausted" | "exhausted";
export type UsageHealth = "ok" | "rate_limited" | "reauth_required" | "unsupported" | "error";
export type UsageWindow = Readonly<{
  id?: string;
  usedPercent?: number;
  status?: UsageWindowStatus;
  quotaLevel?: UsageQuotaLevel;
  windowDurationMinutes: number;
  resetsAt?: string;
}>;
export type UsageOfficialBucket = Readonly<{
  id?: string;
  name?: string;
  description?: string;
  window?: string;
  remainingFraction?: number;
  usedPercent?: number;
  status?: UsageWindowStatus;
  windowDurationMinutes?: number;
  resetsAt?: string;
}>;
export type UsageOfficialGroup = Readonly<{
  name?: string;
  description?: string;
  buckets: readonly UsageOfficialBucket[];
}>;
export type UsageSnapshot = Readonly<{
  provider: RuntimeProvider;
  planType?: string;
  primary?: UsageWindow;
  secondary?: UsageWindow;
  officialGroups?: readonly UsageOfficialGroup[];
  officialDescription?: string;
  credits?: Readonly<{
    hasCredits: boolean;
    unlimited: boolean;
    balance?: string;
  }>;
  creditUsage?: Readonly<{
    used: number;
    limit: number;
    overage: number;
  }>;
  resetCreditsAvailable?: number;
  collectedAt?: string;
  accountLabel?: string;
  health?: UsageHealth;
}>;
export type AgentSessionIdentity = Readonly<{
  sessionId: string;
  state: "empty" | "resumable" | "unknown";
}>;
export type AgentGitHookPlan =
  | {
      readonly kind: "config-hook";
    }
  | {
      readonly kind: "hooks-path";
      readonly hooksDir: string;
    };
type AgentSessionCommonOptions = Readonly<{
  agentId?: string;
  runtimeId?: string;
  agentWorkspaceDirectory: string;
  conversation?: AgentConversationScope;
  instructions: string;
  sessionId?: string;
  sessionMode?: "create" | "resume";
  contextViewRequestLogDirectory?: string;
  onSessionId?(sessionId: string, replacedSessionId?: string): Promise<void>;
  runtime?: AgentRuntimeConfig;
  environment?: Readonly<Record<string, string>>;
  gitHooks?: AgentGitHookPlan;
}>;
export type AgentSessionOptions = AgentSessionCommonOptions;
export type AgentConversationScope = Readonly<{
  conversationId: string;
  target: string;
}>;
export type AgentRuntimeEvent = {
  readonly conversation?: AgentConversationScope;
} & (
  | {
      type: "activity";
      activity: AgentActivity;
    }
  | {
      type: "usage";
      snapshot: UsageSnapshot;
    }
  | {
      type: "context-usage";
      usedTokens: number;
      windowTokens: number;
      occurredAt?: string;
    }
  | {
      type: "text-delta" | "thinking-delta";
      text: string;
      subagent?: ActivitySubagent;
    }
  | {
      type: "session";
      identity: AgentSessionIdentity;
    }
  | {
      type: "tool-start";
      id: string;
      name: string;
      input?: unknown;
      subagent?: ActivitySubagent;
      occurredAt?: string;
    }
  | {
      type: "tool-output";
      id: string;
      text: string;
    }
  | {
      type: "reply-intent";
      id: string;
      target: string;
    }
  | {
      type: "reply-intent-retracted";
      id: string;
    }
  | {
      type: "tool-end";
      id: string;
      isError: boolean;
      exitCode?: number;
      durationMs?: number;
    }
  | {
      type: "completed";
      status: "completed" | "interrupted" | "failed";
    }
  | {
      type: "compaction-started";
      occurredAt?: string;
    }
  | {
      type: "compaction-finished";
      occurredAt?: string;
      tokensBefore?: number;
      tokensAfter?: number;
      windowTokens?: number;
    }
  | {
      type: "service-tier";
      state: AgentServiceTierObserved;
      reason?: string;
    }
  | {
      type: "compaction-interrupted";
      occurredAt?: string;
      interruptedBy?: "aborted" | "failed";
      reason?: string;
      errorMessage?: string;
    }
  | {
      type: "review-started";
      occurredAt?: string;
    }
  | {
      type: "review-finished";
      occurredAt?: string;
    }
  | {
      type: "subagent-progress";
      phase: "started" | "progress" | "notification";
      taskId?: string;
      taskStatus?: "completed" | "failed" | "stopped";
      taskKind?: AgentSubagentTaskKind;
      subagentType?: string;
      parentToolUseId?: string;
      occurredAt?: string;
    }
  | {
      type: "progress";
      source?: string;
      occurredAt?: string;
    }
  | {
      type: "error";
      message: string;
      retryable?: boolean;
      providerErrorCode?: string;
      providerErrorClass?: string;
      httpStatus?: number;
      providerErrorReason?: string;
      sessionRecovery?: "provider_replay_rejected";
      providerLimit?: {
        kind: "quota_exhausted" | "window_limit" | "transient_rate_limit";
        resetsAt?: string;
      };
      occurredAt?: string;
    }
  | {
      type: "reconnecting";
      attempt?: number;
      maxAttempts?: number;
      delayMs?: number;
      message?: string;
    }
  | {
      type: "notice-undelivered";
      text: string;
      deliveryIds?: readonly string[];
    }
);
export type {
  AgentNoticeOptions,
  AgentSession,
  AgentSessionExit,
  AgentTurnProcessWindow,
} from "./agent-session-contract";
