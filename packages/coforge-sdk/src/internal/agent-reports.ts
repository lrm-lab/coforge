// Agent status, activity, session, context-usage and service-tier reports, Daemon to cloud.

import { RPC_METHODS } from "./rpc-methods";
import type { RuntimeProvider } from "./runtime-provider";
import type { AgentServiceTierObserved } from "./service-tier";

export const AGENT_STATUS_METHOD = RPC_METHODS.agentStatus;
export const AGENT_ACTIVITY_METHOD = RPC_METHODS.agentActivity;
/** Stable Activity detail kinds shared by the Daemon producer and the Web consumer. */
export const AGENT_ACTIVITY_DETAIL_KIND = {
  MODEL_REQUEST_STARTED: "model_request_started",
  MODEL_RESPONSE_STARTED: "model_response_started",
  THINKING_STARTED: "thinking_started",
  FRESHNESS_HOLD: "freshness_hold",
  STARTING: "starting",
  STOPPED: "stopped",
  IDLE: "idle",
  RUNNING_COMMAND: "running_command",
  TOOL_STARTED: "tool_started",
  CHECKING_MESSAGES: "checking_messages",
  RUNTIME_RECONNECTING: "runtime_reconnecting",
  RUNTIME_ERROR: "runtime_error",
  // A stored native Session could not be resumed (missing, or rejected on replay); the
  // daemon reported it invalidated and is cold-starting without it. Working-level,
  // like `runtime_reconnecting` above: it narrates a fallback in progress, not a terminal state.
  RUNTIME_UNAVAILABLE: "runtime_unavailable",
  // Content-free provider stream/system event (no rendered text): keeps the
  // busy lease warm without adding a trajectory entry.
  RUNTIME_PROGRESS: "runtime_progress",
  // Busy status rows that close a step: stored in history and shown like any
  // other row. Renew the display lease the same way runtime_progress does.
  TOOL_END: "tool_end",
  THINKING_END: "thinking_end",
  COMPACTION_FINISHED: "compaction_finished",
  // The provider's review pass ended; same liveness-only class as
  // compaction_finished/tool_end above.
  REVIEW_FINISHED: "review_finished",
  // Visible, stored busy detail kinds.
  COMPACTING_CONTEXT: "compacting_context",
  SUBAGENT_ACTIVITY: "subagent_activity",
  MESSAGE_RECEIVED: "message_received",
  // The Agent's provider entered a review pass.
  REVIEWING_CHANGES: "reviewing_changes",
  // Compaction started and no finish was observed for a long time.
  COMPACTION_STALE: "compaction_stale",
  // This launch asked for the runtime's Fast service tier and the runtime reported it is not
  // applied (off, cooling down, or unreported). Warning level; one row per launch.
  FAST_MODE_UNAVAILABLE: "fast_mode_unavailable",
  // This launch skipped stored Agent environment variables the shared rule refuses (they could
  // change how the runtime or its toolchain executes). Warning level; one row per launch, naming
  // each skipped variable so it can be removed.
  AGENT_ENVIRONMENT_IGNORED: "agent_environment_ignored",
  // A review pass started and no finish was observed for a long time.
  REVIEW_STALE: "review_stale",
  // The daemon is restarting a provider it found stalled.
  STALLED_RECOVERY: "stalled_recovery",
  // The daemon injected a system/control message into the Agent's session.
  SYSTEM_MESSAGE: "system_message",
  // Terminal detail kinds.
  RUNTIME_CRASHED: "runtime_crashed",
  RUNTIME_INTERRUPTED: "runtime_interrupted",
  // The provider has produced nothing for too long while work is pending.
  // Error-level presentation, like runtime_error/runtime_crashed above.
  RUNTIME_STALLED: "runtime_stalled",
  // Computer lifecycle rows. Only the server writes them, into each of a Computer's Agents'
  // Activity: `computer_disconnected` on a shutdown notice, one of the others when a new daemon
  // instance is ready. They never change a status; all are info level except
  // `computer_operation_failed` (an upgrade that did not complete), which is error level and
  // carries what still runs and what to do in its detail.
  COMPUTER_DISCONNECTED: "computer_disconnected",
  COMPUTER_STARTED: "computer_started",
  COMPUTER_RESTARTED: "computer_restarted",
  COMPUTER_UPGRADED: "computer_upgraded",
  COMPUTER_OPERATION_FAILED: "computer_operation_failed",
  OTHER: "other",
} as const;
export type AgentActivityDetailKind =
  (typeof AGENT_ACTIVITY_DETAIL_KIND)[keyof typeof AGENT_ACTIVITY_DETAIL_KIND];
export const AGENT_SESSION_METHOD = RPC_METHODS.agentSession;
export type AgentSessionReport = {
  protocolMajor: number;
  requestId: string;
  workspaceId: string;
  computerId: string;
  agentId: string;
  provider: RuntimeProvider;
  sessionId: string;
  startRequestId: string;
  daemonInstanceId: string;
  launchId: string;
  previousLaunchId?: string;
  replacedSessionId?: string;
  controlEpoch?: number;
  sequence?: number;
  sessionState?: "empty" | "resumable" | "unknown";
};
export const AGENT_SESSION_INVALIDATE_METHOD = RPC_METHODS.agentSessionInvalidate;
/** `missing`: the stored native Session no longer exists. `provider_replay_rejected`: the
 * provider rejected replaying it. Mirrors `AgentSessionRecoveryCode`, minus `session_in_use`. */
export const AGENT_SESSION_INVALIDATE_REASONS = {
  MISSING: "missing",
  PROVIDER_REPLAY_REJECTED: "provider_replay_rejected",
} as const;
export type AgentSessionInvalidateReason =
  (typeof AGENT_SESSION_INVALIDATE_REASONS)[keyof typeof AGENT_SESSION_INVALIDATE_REASONS];
/**
 * Fire-and-forget daemon-to-cloud notice that a stored native Session is gone or was
 * rejected on replay; the daemon is cold-starting without it. Never delivered as Activity.
 * No control-fence fields (no `startRequestId`/`controlEpoch`, unlike `AgentSessionReport`):
 * the server's exact match is on `launchId` + `sessionId` alone.
 */
export type AgentSessionInvalidate = {
  protocolMajor: number;
  requestId: string;
  workspaceId: string;
  computerId: string;
  agentId: string;
  provider: RuntimeProvider;
  sessionId: string;
  daemonInstanceId: string;
  launchId: string;
  reason: AgentSessionInvalidateReason;
};
export const AGENT_CONTEXT_USAGE_METHOD = RPC_METHODS.agentContextUsage;
/**
 * Fire-and-forget daemon-to-cloud notice of the Agent's current context-window usage, observed
 * at the top-level Claude Code `result` record. Never delivered as Activity; a
 * provider with no such signal never emits it (Claude Code only today). This message never
 * shipped, so its fields are numbered contiguously.
 */
export type AgentContextUsage = {
  protocolMajor: number;
  requestId: string;
  workspaceId: string;
  computerId: string;
  agentId: string;
  provider: RuntimeProvider;
  launchId: string;
  sessionId: string;
  usedTokens: number;
  windowTokens: number;
  observedAtMs: number;
  daemonInstanceId: string;
  clientSeq: number;
};
export const AGENT_SERVICE_TIER_METHOD = RPC_METHODS.agentServiceTier;
/**
 * Fire-and-forget daemon-to-cloud notice of the service tier an Agent's launch actually observed,
 * read from the runtime's own per-turn report (Claude Code's `fast_mode_state`). Never delivered
 * as Activity; a provider with no such signal never emits it. `requested` echoes the launch's
 * ask, so the reader can tell "Fast was requested and is off" from "Fast was not requested".
 */
export type AgentServiceTier = {
  protocolMajor: number;
  requestId: string;
  workspaceId: string;
  computerId: string;
  agentId: string;
  provider: RuntimeProvider;
  launchId: string;
  sessionId: string;
  requested: boolean;
  observed: AgentServiceTierObserved;
  observedAtMs: number;
  daemonInstanceId: string;
  clientSeq: number;
};
export type AgentActivity = {
  protocolMajor: number;
  requestId: string;
  workspaceId: string;
  agentId: string;
  detailKind: string;
  level: "info" | "warning" | "error";
  detail: string;
  messageId?: string;
  conversationId?: string;
  conversationTarget?: string;
  observedAtMs: number;
  launchId: string;
  clientSeq: number;
  activityKind?: import("./agent-display").AgentActivityKind;
  entries?: import("./activity-entries").ActivityTrajectoryEntry[];
  /** `tool_end` only: how the call ended. Absent from older daemons. */
  toolOutcome?: import("./activity-tool-outcome").ActivityToolOutcome;
  /** True when this frame re-sends the last busy activity to renew the display lease. */
  isHeartbeat?: boolean;
  /** Set only on the daemon's reply to an AgentActivityProbe; echoes its probeId. */
  probeId?: string;
  /** `freshness_decision_fact:<sha256>` lineage of the decision this row narrates; freshness-hold
   * rows only. */
  producerFactId?: string;
  runtimeError?: import("./runtime-error-action").AgentActivityRuntimeError;
};
export type AgentStatus = {
  protocolMajor: number;
  requestId: string;
  workspaceId: string;
  computerId: string;
  agentId: string;
  status: "active" | "inactive";
  daemonInstanceId: string;
  clientSeq: number;
  observedAtMs: number;
};
