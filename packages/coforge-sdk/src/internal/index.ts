import type { MemoryAgentToolProfile } from "../agent/memory-tool-fences";
import { RPC_METHODS } from "./rpc-methods";
import type { AgentServiceTierObserved } from "./service-tier";
import { MESSAGE_ANCHOR_SOURCE, UUID_LIKE_SOURCE } from "./uuid";
/** TypeScript boundary; codec/transport remains an adapter concern. */
export const COMPUTER_REGISTER_METHOD = RPC_METHODS.computerRegister;
export const COMPUTER_REGISTER_PROTOCOL_MAJOR = 1 as const;
export const WORKSPACE_LIST_METHOD = RPC_METHODS.workspaceList;
export const WORKSPACE_GET_METHOD = RPC_METHODS.workspaceGet;
export const DAEMON_RUNTIME_READY_METHOD = RPC_METHODS.daemonRuntimeReady;
export const DAEMON_CONNECTION_STATUS_METHOD = RPC_METHODS.daemonConnectionStatus;
export const DAEMON_RUNTIME_CODE_AGENTS_UPDATE_METHOD = RPC_METHODS.daemonCodeAgentsUpdate;
export const DAEMON_RUNTIME_USAGE_SCAN_METHOD = RPC_METHODS.daemonUsageScan;
export const DAEMON_RUNTIME_USAGE_SCAN_RESULT_METHOD = RPC_METHODS.daemonUsageScanResult;
export const DAEMON_RUNTIME_MODEL_REFRESH_METHOD = RPC_METHODS.daemonModelRefresh;
export const DAEMON_RUNTIME_MODEL_REFRESH_RESULT_METHOD = RPC_METHODS.daemonModelRefreshResult;
export const COMPUTER_RESTART_METHOD = RPC_METHODS.computerRestart;
export const COMPUTER_RESTART_MESSAGE_TYPE = "coforge.rpc.v1.ComputerRestartIntent" as const;
export const COMPUTER_UPGRADE_METHOD = RPC_METHODS.computerUpgrade;
export const COMPUTER_UPGRADE_MESSAGE_TYPE = "coforge.rpc.v1.ComputerUpgradeIntent" as const;
export const COMPUTER_UPGRADE_RESULT_METHOD = RPC_METHODS.computerUpgradeResult;
export const COMPUTER_UPGRADE_RESULT_MESSAGE_TYPE = "coforge.rpc.v1.ComputerUpgradeResult" as const;
export const AGENT_START_METHOD = RPC_METHODS.agentStart;
export const AGENT_START_MESSAGE_TYPE = "coforge.rpc.v1.AgentStartIntent" as const;
export const AGENT_STOP_METHOD = RPC_METHODS.agentStop;
export const AGENT_STOP_MESSAGE_TYPE = "coforge.rpc.v1.AgentStopIntent" as const;
export const AGENT_ACTIVITY_PROBE_METHOD = RPC_METHODS.agentActivityProbe;
export const AGENT_ACTIVITY_PROBE_MESSAGE_TYPE = "coforge.rpc.v1.AgentActivityProbe" as const;
export const AGENT_INBOX_PURGE_METHOD = RPC_METHODS.agentInboxPurge;
export const AGENT_INBOX_PURGE_MESSAGE_TYPE = "coforge.rpc.v1.AgentInboxPurge" as const;
/** Why an Agent lost read access to channels. */
export const AGENT_INBOX_PURGE_REASONS = ["member_removed", "left", "visibility_private"] as const;
export type AgentInboxPurgeReason = (typeof AGENT_INBOX_PURGE_REASONS)[number];
/** Why a daemon rejected a delivery instead of taking custody of it. */
export const AGENT_MESSAGE_DELIVERY_REJECTION_REASONS = ["no_process"] as const;
export type AgentDeliveryRejectionReason =
  (typeof AGENT_MESSAGE_DELIVERY_REJECTION_REASONS)[number];
export const USAGE_SCAN_MESSAGE_TYPE = "coforge.rpc.v1.DaemonRuntimeUsageScanRequest" as const;
export const USAGE_SCAN_RESPONSE_MESSAGE_TYPE =
  "coforge.rpc.v1.DaemonRuntimeUsageScanResponse" as const;
export const MODEL_REFRESH_MESSAGE_TYPE =
  "coforge.rpc.v1.DaemonRuntimeProviderModelRefreshRequest" as const;
export const MODEL_REFRESH_RESPONSE_MESSAGE_TYPE =
  "coforge.rpc.v1.DaemonRuntimeProviderModelRefreshResponse" as const;
/** Server -> daemon, on the daemon control channel like the usage scan; per-Agent
 * rather than per-provider, so it decodes through the same `#route` chain in
 * `daemon-connection.ts` rather than a dedicated method the daemon calls. */
export const AGENT_CONTEXT_SCAN_METHOD = RPC_METHODS.agentContextScan;
/** Daemon -> server RPC carrying the scan's result. */
export const AGENT_CONTEXT_SCAN_RESULT_METHOD = RPC_METHODS.agentContextScanResult;
export const AGENT_CONTEXT_SCAN_MESSAGE_TYPE = "coforge.rpc.v1.AgentContextScanRequest" as const;
export const AGENT_CONTEXT_SCAN_RESPONSE_MESSAGE_TYPE =
  "coforge.rpc.v1.AgentContextScanResponse" as const;
export type DaemonRuntimeMessageType =
  | typeof AGENT_START_MESSAGE_TYPE
  | typeof AGENT_STOP_MESSAGE_TYPE
  | typeof USAGE_SCAN_MESSAGE_TYPE
  | typeof USAGE_SCAN_RESPONSE_MESSAGE_TYPE
  | typeof MODEL_REFRESH_MESSAGE_TYPE
  | typeof MODEL_REFRESH_RESPONSE_MESSAGE_TYPE
  | typeof AGENT_CONTEXT_SCAN_MESSAGE_TYPE
  | typeof AGENT_CONTEXT_SCAN_RESPONSE_MESSAGE_TYPE;
export const AGENT_MESSAGE_METHOD = RPC_METHODS.agentMessage;
export const AGENT_MESSAGE_ACK_METHOD = RPC_METHODS.agentMessageAck;
export const AGENT_MESSAGE_REJECT_METHOD = RPC_METHODS.agentMessageReject;
export const AGENT_CHANNEL_MUTE_METHOD = RPC_METHODS.agentChannelMute;
export const AGENT_CHANNEL_UNMUTE_METHOD = RPC_METHODS.agentChannelUnmute;
export const AGENT_THREAD_UNFOLLOW_METHOD = RPC_METHODS.agentThreadUnfollow;
export const isChannelTarget = (target: string): boolean =>
  /^#[a-z0-9][a-z0-9_-]{0,31}$/.test(target);
export const isChannelMessageTarget = (target: string): boolean =>
  new RegExp(
    `^#[a-z0-9][a-z0-9_-]{0,31}(?::(?:${MESSAGE_ANCHOR_SOURCE}|${UUID_LIKE_SOURCE}))?$`,
  ).test(target);
/** A thread target split at its first `:` into parent and root, or `undefined` for a top-level
 * target. */
const splitThreadTarget = (target: string): [parent: string, root: string] | undefined => {
  const index = target.indexOf(":");
  return index === -1 ? undefined : [target.slice(0, index), target.slice(index + 1)];
};
/**
 * The parent of a thread target (everything before the first `:`), or `undefined` for a
 * top-level target. `#general:12345678` → `#general`; `@frank:12345678` → `@frank`; `#general` →
 * `undefined`.
 */
export const threadParentTarget = (target: string): string | undefined =>
  splitThreadTarget(target)?.[0];
/**
 * The root of a thread target (everything after the first `:`), or `undefined` for a top-level
 * target. `#general:12345678` → `12345678`; `#general` → `undefined`.
 */
export const threadRootTarget = (target: string): string | undefined =>
  splitThreadTarget(target)?.[1];
/** A reaction emoji: trimmed, one to sixteen characters, no whitespace. */
export const isValidReactionEmoji = (value: string): boolean =>
  value.trim() === value && value.length >= 1 && value.length <= 16 && !/\s/.test(value);
export const MEMORY_OFFER_REQUIRED_MESSAGE =
  "An explicit @memory question must be answered with memory_offer";
export const AGENT_MESSAGE_VALIDATION_MESSAGES = [
  "message anchor must be eight hexadecimal characters or a full UUID",
  "ambiguous message prefix; use the full UUID",
  "message anchor not found in this conversation",
  "thread root must be a top-level message",
  "message anchor is outside this target",
  "message not found or not visible to this Agent",
  "reaction emoji must be one to sixteen characters without whitespace",
  "mute requires a channel target",
  "unfollow requires a channel thread target",
  MEMORY_OFFER_REQUIRED_MESSAGE,
  "search `before` must be an ISO time, such as 2026-09-01T00:00:00Z",
  "search `after` must be an ISO time, such as 2026-09-01T00:00:00Z",
] as const;
export type AgentMessageValidationMessage = (typeof AGENT_MESSAGE_VALIDATION_MESSAGES)[number];
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
export const WORKSPACE_PROTOCOL_MAJOR = COMPUTER_REGISTER_PROTOCOL_MAJOR;
export type Workspace = { id: string; slug: string; name: string };
export * from "./workspace-info";
export const AGENT_WORKSPACE_INFO_METHOD = RPC_METHODS.agentWorkspaceInfo;

export type WorkspaceQueryRequest = {
  protocolMajor: number;
  requestId: string;
  workspaceSlug?: string;
};

export * from "./runtime-provider";
import type { RuntimeProvider } from "./runtime-provider";
export type AgentRuntimeProviderConfig =
  | { kind: "default" }
  | { kind: "coforge"; providerId: string };

export * from "./upgrade-error-code";

/**
 * Every top-level `coforge-computer` command, as `packages/computer/src/cli.ts` registers them.
 * Shared here: the module both `packages/computer` (which registers them) and `apps/web`
 * (which tells a Workspace member which one to run next, in `upgrade-failure.ts`) already
 * depend on - so a web copy string naming a command that does not exist, or a renamed CLI
 * command that copy never updated for, is one drift this constant lets a test catch instead of
 * the two packages silently disagreeing. `packages/computer/test/cli.test.ts` asserts the CLI's
 * CLI names.
 */
export const COMPUTER_CLI_COMMANDS = [
  "login",
  "logout",
  "setup",
  "install",
  "upgrade",
  "recover",
  "start",
  "stop",
  "restart",
  "foreground",
  "logs",
  "status",
  "doctor",
  "host",
] as const;
export type ComputerCliCommand = (typeof COMPUTER_CLI_COMMANDS)[number];
export type RuntimeMetadata = {
  provider: RuntimeProvider;
  version: string;
  displayName: string;
};
export type CodeAgentModelMetadata = {
  id: string;
  displayName: string;
  description: string;
  modelProvider: string;
  reasoningEfforts: string[];
  defaultReasoning: string;
  recommended: boolean;
};
export type CodeAgentModelCatalog = {
  provider: RuntimeProvider;
  models: CodeAgentModelMetadata[];
};
export type ComputerRegisterRequest = {
  protocolMajor: number;
  requestId: string;
  workspaceSlug: string;
  name: string;
  displayName: string;
  machineId: string;
  platform: string;
  osVersion: string;
  computerVersion: string;
  registrationIdempotencyKey: string;
};
export type ComputerRegisterResponse = {
  protocolMajor: number;
  requestId: string;
  computerId: string;
  workspaceId: string;
  daemonApiKey: string;
};
export type DaemonRuntimeReadyRequest = {
  protocolMajor: number;
  requestId: string;
  workspaceId: string;
  computerId: string;
  workerInstanceId: string;
  daemonVersion?: string;
  computerVersion?: string;
  platform?: string;
  osVersion?: string;
  startedAt: number;
  runningAgentIds: string[];
  recoveredRestartRequestIds?: string[];
  recoveredUpgradeRequestIds?: string[];
  capabilities?: string[];
};
export type ComputerRestartIntent = {
  protocolMajor: number;
  requestId: string;
  workspaceId: string;
  computerId: string;
  messageType?: typeof COMPUTER_RESTART_MESSAGE_TYPE;
};
export type ComputerUpgradeIntent = {
  protocolMajor: number;
  requestId: string;
  workspaceId: string;
  computerId: string;
  target: "latest";
  expectedVersion?: string;
  messageType?: typeof COMPUTER_UPGRADE_MESSAGE_TYPE;
};
/** One Computer upgrade operation's terminal report, from the Daemon to the server. */
export type ComputerUpgradeResult = {
  protocolMajor: number;
  requestId: string;
  workspaceId: string;
  computerId: string;
  status: "succeeded" | "failed";
  completedAtMs: number;
  version?: string;
  error?: string;
  /** See `UPGRADE_ERROR_CODE`. May be a well-formed code this SDK build does not know the name
   * of yet - the shape is validated, the vocabulary membership is not. */
  errorCode?: string;
  messageType?: typeof COMPUTER_UPGRADE_RESULT_MESSAGE_TYPE;
};
export type DaemonRuntimeCodeAgentsUpdateRequest = {
  protocolMajor: number;
  requestId: string;
  workspaceId: string;
  computerId: string;
  runtimes: RuntimeMetadata[];
  catalogs: CodeAgentModelCatalog[];
};
export type DaemonRuntimeUsageScanRequest = {
  protocolMajor: number;
  requestId: string;
  workspaceId: string;
  computerId: string;
  provider: RuntimeProvider;
  messageType?: DaemonRuntimeMessageType;
};
export type DaemonRuntimeUsageScanResponse = DaemonRuntimeUsageScanRequest & {
  accepted: boolean;
  status: string;
  message?: string;
  snapshotJson?: Uint8Array;
};
/** Server -> daemon, on the daemon control channel like the usage scan: re-run Code Agent
 * model-catalog discovery on demand so the browser's model selector can pick up a provider config
 * change without a daemon restart. */
export type DaemonRuntimeProviderModelRefreshRequest = {
  protocolMajor: number;
  requestId: string;
  workspaceId: string;
  computerId: string;
  messageType?: DaemonRuntimeMessageType;
};
/** Daemon -> server. `catalogs` carries the freshly discovered catalog when `status` is
 * `refreshed`; `status` is one of `refreshed | refused | error`. */
export type DaemonRuntimeProviderModelRefreshResponse = DaemonRuntimeProviderModelRefreshRequest & {
  accepted: boolean;
  status: string;
  message?: string;
  catalogs?: CodeAgentModelCatalog[];
};
/** Server -> daemon, on the daemon control channel like the usage scan. Per-Agent: the
 * server fills `launchId`/`sessionId` from its own record of the Agent's current control state;
 * the daemon still resolves its own current launch/session independently before running anything
 * (see `DaemonRuntime.scanAgentContext`) rather than trusting these fields outright. */
export type AgentContextScanRequest = {
  protocolMajor: number;
  requestId: string;
  workspaceId: string;
  computerId: string;
  agentId: string;
  provider: RuntimeProvider;
  launchId: string;
  sessionId: string;
  messageType?: DaemonRuntimeMessageType;
};
export const AGENT_CONTEXT_SCAN_STATUS = {
  AVAILABLE: "available",
  UNSUPPORTED: "unsupported",
  NO_SESSION: "no_session",
  UNPARSED: "unparsed",
  TIMEOUT: "timeout",
  ERROR: "error",
} as const;
export type AgentContextScanStatus =
  (typeof AGENT_CONTEXT_SCAN_STATUS)[keyof typeof AGENT_CONTEXT_SCAN_STATUS];
/** Daemon -> server RPC (method `agent:context_scan_result`). `reportJson` decodes to
 * `AgentContextReport`, present only when `status` is `"available"`. */
export type AgentContextScanResponse = AgentContextScanRequest & {
  accepted: boolean;
  status: AgentContextScanStatus;
  message?: string;
  reportJson?: Uint8Array;
};
/**
 * A parsed Claude Code `/context` report: what the current context window is made of,
 * by category, plus the per-item Memory files/Skills lists. Claude Code only today; a provider
 * with no equivalent signal never produces one. Categories are free text, kept exactly as the CLI
 * printed them (English, Claude Code's own labels — never translated); `"Free space"` is
 * recognized by name to draw the remainder in the UI. `approximate` marks a token count the CLI
 * itself only bounded (its `< N` form), never a value this parser guessed.
 */
export type AgentContextReport = {
  provider: RuntimeProvider;
  model?: string;
  usedTokens: number;
  windowTokens: number;
  observedAt: string;
  categories: { name: string; tokens: number; approximate?: boolean }[];
  memoryFiles?: { kind: string; path: string; tokens: number; approximate?: boolean }[];
  skills?: { name: string; source: string; tokens: number; approximate?: boolean }[];
};
export type AgentStartIntent = {
  protocolMajor: number;
  requestId: string;
  workspaceId: string;
  computerId: string;
  agentId: string;
  provider: RuntimeProvider;
  model: string;
  modelProvider?: string;
  reasoning: string;
  sessionId?: string;
  sessionMode?: "create" | "resume";
  previousLaunchId?: string;
  controlEpoch?: number;
  /** The server-minted launchId for this control operation's start step; required
   * whenever `controlEpoch` is set (every managed start). */
  launchId?: string;
  /** Fenced Agent runtime profile. Unknown values are rejected by the codec. */
  toolProfile?: MemoryAgentToolProfile;
  memoryAgent?: boolean;
  providerConfig?: AgentRuntimeProviderConfig;
  wakeMessage?: AgentRecoveryMessage;
  resumeMessages?: AgentRecoveryMessage[];
  unreadSummary?: Readonly<Record<string, number>>;
  unreadConversationIds?: Readonly<Record<string, string>>;
  /** Text the Agent's first turn opens with, in place of message recovery: the guidance a user
   * gives when resuming Agents they stopped. Never carried together with `wakeMessage`,
   * `resumeMessages` or `unreadSummary`. */
  resumePrompt?: string;
  /** Server-written text for an Agent that has not yet introduced itself to its creator: the
   * launch's first turn, in place of the empty-launch starter. Carried on every start until the
   * server records the introduction, and may accompany recovery and `resumePrompt`. */
  introductionPrompt?: string;
  /** Whether this launch asks the runtime for its Fast service tier. Absent means the ordinary
   * tier; an older daemon that never heard of it ignores it. */
  fastMode?: boolean;
};
export type AgentStopIntent = {
  protocolMajor: number;
  requestId: string;
  workspaceId: string;
  computerId: string;
  agentId: string;
  provider?: RuntimeProvider;
  controlEpoch?: number;
  messageType?: typeof AGENT_STOP_MESSAGE_TYPE;
};
/** Versioned server-to-daemon liveness probe; the daemon answers with an AgentActivity. */
export type AgentActivityProbe = {
  protocolMajor: number;
  requestId: string;
  workspaceId: string;
  computerId: string;
  agentId: string;
  probeId: string;
};
/** Versioned server-to-daemon notice that an Agent can no longer read these channels (and their
 * threads); the daemon drops, and acknowledges, its local state for them. One-way. */
export type AgentInboxPurge = {
  protocolMajor: number;
  requestId: string;
  workspaceId: string;
  computerId: string;
  agentId: string;
  conversationIds: string[];
  targets: string[];
  reason: AgentInboxPurgeReason;
};
export type AgentRecoveryMessage = {
  memoryHint?: import("#src/agent/memory-disposition").MemoryHintDelivery;
  messageId: string;
  deliveryId: string;
  conversationId: string;
  sequence: number;
  target: string;
  latestSenderKind: import("./message-sender").MessageSenderKind;
  latestSenderHandle: string;
  latestSenderDescription: string;
  body: string;
  /** True when the Agent is not in the channel and was notified of this one message. */
  nonMemberMention?: boolean;
};
export type AgentMessageDelivery = {
  memoryHint?: import("#src/agent/memory-disposition").MemoryHintDelivery;
  protocolMajor: number;
  requestId: string;
  messageId: string;
  deliveryId: string;
  sequence: number;
  workspaceId: string;
  conversationId: string;
  agentId: string;
  body: string;
  method: typeof AGENT_MESSAGE_METHOD;
  target?: string;
  latestSenderKind?: import("./message-sender").MessageSenderKind;
  latestSenderHandle?: string;
  latestSenderDescription?: string;
  /** True when this delivery personally @mentioned the recipient Agent. */
  mentionsAgent?: boolean;
  /** True when the recipient Agent was notified of this message without being a channel member. */
  nonMemberMention?: boolean;
  /** Present when this delivery starts an isolated Task execution session. */
  taskExecutionSessionId?: string;
  /** Present on a tracked @mention delivery; an ACK echoes it once the mention is drained. */
  mentionDelivery?: import("./mention-delivery").MentionDeliveryEnvelope;
};
export type AgentMessageDeliveryAck = Omit<
  AgentMessageDelivery,
  "body" | "conversationId" | "method" | "requestId"
> & { method: typeof AGENT_MESSAGE_ACK_METHOD; requestId: string };
/** Versioned daemon-to-server rejection of a delivery: never an ACK, so the delivery stays unread. */
export type AgentMessageDeliveryRejection = Omit<AgentMessageDeliveryAck, "method"> & {
  method: typeof AGENT_MESSAGE_REJECT_METHOD;
  reason: AgentDeliveryRejectionReason;
};
export { ACTIVITY_SUBAGENT_TYPE_MAX, parseActivityEntries } from "./activity-entries";
export {
  HELD_CONTEXT_LIMIT,
  SEEN_EXACT_SEQS_LIMIT,
  isSeenExactSeqs,
  mergeSeenExactSeqs,
  normalizeSeenExactSeqs,
  freshnessDecisionFactId,
  stableNormalizeFreshnessFact,
} from "./freshness-decision";
export type { FreshnessDecisionAction, FreshnessDecisionFactInput } from "./freshness-decision";
export { codePointLength, truncateCodePoints, truncateCodePointsWithEllipsis } from "./truncate";
export {
  compareReleaseVersions,
  isValidReleaseVersion,
  parseReleaseVersion,
  COMPUTER_RELEASE_APP,
  RELEASE_NOTES_MAX_LENGTH,
} from "./release-version";
export type { ReleaseNotes } from "./release-version";
export { isActivityCallId } from "./activity-entries";
export type { ActivityTrajectoryEntry, ActivitySubagent } from "./activity-entries";
export { isActivityExitCode, isActivityToolOutcome } from "./activity-tool-outcome";
export type { ActivityToolOutcome } from "./activity-tool-outcome";
export * from "./runtime-error-action";

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
export type AgentMessageRequest = {
  idempotencyKey: string;
  agentId: string;
  workspaceId: string;
  fromSequence?: number;
  throughSequence?: number;
  unread?: boolean;
  operation:
    | "check"
    | "read"
    | "search"
    | "send"
    | "mute"
    | "unmute"
    | "thread-unfollow"
    | "resolve"
    | "react"
    | "unreact";
  target: string;
  content?: string;
  continueAnyway?: boolean;
  /** `send` only: the boundary the sender has already reviewed. */
  seenUpToSeq?: number;
  /** `send` only: `seenExactSeqs`, the messages above `seenUpToSeq` the sender was shown one by
   * one, ascending, at most `SEEN_EXACT_SEQS_LIMIT`. */
  seenExactSeqs?: number[];
  /** `send` only: how many times this draft has already been held (`continueAnywaySuggested`). */
  draftReholdCount?: number;
  /** `send` only: a normal send that replaced an already-held draft. */
  draftReplacedExisting?: boolean;
  /** `send` only: this is the resend of a held draft. */
  sendDraft?: boolean;
  before?: string;
  after?: string;
  around?: string;
  limit?: number;
  freshnessContextMode?: "inline" | "withheld";
  messageId?: string;
  emoji?: string;
  /** `send` only: attachments already uploaded to this conversation, in send order. */
  attachmentIds?: string[];
  /** `send` only: structured @mention bindings; see `LocalMentionSelector`. */
  mentions?: import("./local-daemon").LocalMentionSelector[];
} & import("./local-daemon").LocalMessageSearchFields;
export interface ComputerRegisterTransport {
  request(
    method: typeof COMPUTER_REGISTER_METHOD,
    payload: ComputerRegisterRequest,
  ): Promise<ComputerRegisterResponse>;
}

export class ComputerRegistrationClient {
  constructor(private readonly transport: ComputerRegisterTransport) {}
  register(request: ComputerRegisterRequest): Promise<ComputerRegisterResponse> {
    if (request.protocolMajor !== COMPUTER_REGISTER_PROTOCOL_MAJOR)
      throw new Error("unsupported computer register protocol major");
    return this.transport.request(COMPUTER_REGISTER_METHOD, request).then((response) => {
      if (response.protocolMajor !== COMPUTER_REGISTER_PROTOCOL_MAJOR)
        throw new Error("unsupported response protocol major");
      return response;
    });
  }
}

export interface WorkspaceQueryTransport {
  listAccessible(request: WorkspaceQueryRequest): Promise<Workspace[]>;
  getBySlug(request: WorkspaceQueryRequest): Promise<Workspace>;
}

export {
  DAEMON_HANDSHAKE_METHOD,
  WORKSPACE_CLOUD_CONNECTION_STATES,
  decodeDaemonHandshakeRequest,
  decodeDaemonHandshakeResponse,
  encodeDaemonHandshakeRequest,
  encodeDaemonHandshakeResponse,
  frameLocalRpc,
  readLocalRpcFrame,
  readLocalRpcFrames,
  DAEMON_RUNTIME_CONFIGURE_METHOD,
  LOCAL_RPC_PROTOCOL_MAJOR,
  LOCAL_RPC_METHODS,
  encodeLocalRpcRequest,
  decodeLocalRpcRequest,
  encodeLocalRpcResponse,
  decodeLocalRpcResponse,
  encodeDaemonRuntimeConfigureRequest,
  decodeDaemonRuntimeConfigureRequest,
  encodeDaemonRuntimeConfigureResponse,
  decodeDaemonRuntimeConfigureResponse,
  encodeDaemonCommandRequest,
  decodeDaemonCommandRequest,
  encodeDaemonCommandResponse,
  decodeDaemonCommandResponse,
  encodeAgentMessageResponse,
  decodeAgentMessageResponse,
  encodeLocalInboxRequest,
  decodeLocalInboxRequest,
  encodeInboxResponse,
  decodeInboxResponse,
  encodeLocalAttachment,
  encodeLocalAttachments,
  decodeLocalAttachments,
  encodeUsageScanRequest,
  decodeUsageScanRequest,
  encodeUsageScanResponse,
  decodeUsageScanResponse,
} from "./local-daemon";
export * from "./runner-hold";
export type {
  AgentMessageRecord,
  MessageTaskMetadata,
  LocalMentionSelector,
  LocalAttachment,
  LocalSearchPaging,
} from "./local-daemon";
export type {
  DaemonHandshakeRequest,
  DaemonHandshakeResponse,
  DaemonRuntimeConfigureRequest,
  DaemonRuntimeConfigureResponse,
  LocalRpcRequest,
  LocalRpcResponse,
  DaemonCommandRequest,
  DaemonCommandResponse,
  ManagedRuntimeIdentity,
  WorkspaceCloudConnection,
  LocalAgentMessageRequest,
  AgentMessageResponse,
  LocalInboxRequest,
  InboxResponse,
  InboxEntry,
  AppInboxItem,
  UsageScanRequest,
  UsageScanResponse,
} from "./local-daemon";
export {
  encodeDaemonRuntimeReadyRequest,
  decodeDaemonRuntimeReadyRequest,
  encodeDaemonRuntimeCodeAgentsUpdateRequest,
  decodeDaemonRuntimeCodeAgentsUpdateRequest,
  encodeDaemonRuntimeUsageScanRequest,
  decodeDaemonRuntimeUsageScanRequest,
  encodeDaemonRuntimeUsageScanResponse,
  decodeDaemonRuntimeUsageScanResponse,
  encodeDaemonRuntimeProviderModelRefreshRequest,
  decodeDaemonRuntimeProviderModelRefreshRequest,
  encodeDaemonRuntimeProviderModelRefreshResponse,
  decodeDaemonRuntimeProviderModelRefreshResponse,
  encodeAgentContextScanRequest,
  decodeAgentContextScanRequest,
  encodeAgentContextScanResponse,
  decodeAgentContextScanResponse,
  encodeComputerRestartIntent,
  decodeComputerRestartIntent,
  encodeComputerUpgradeIntent,
  decodeComputerUpgradeIntent,
  encodeComputerUpgradeResult,
  decodeComputerUpgradeResult,
  sanitizeUpgradeErrorText,
} from "./codec";
export {
  encodeAgentContextUsage,
  decodeAgentContextUsage,
  encodeAgentServiceTier,
  decodeAgentServiceTier,
} from "./agent-observation-codec";
export {
  encodeAgentSessionReport,
  decodeAgentSessionReport,
  encodeAgentSessionInvalidate,
  decodeAgentSessionInvalidate,
  AGENT_START_PROMPT_MAX_LENGTH,
  encodeAgentStartIntent,
  decodeAgentStartIntent,
  encodeAgentStopIntent,
  decodeAgentStopIntent,
  encodeAgentActivityProbe,
  decodeAgentActivityProbe,
  encodeAgentInboxPurge,
  decodeAgentInboxPurge,
  encodeAgentMessageDelivery,
  decodeAgentMessageDelivery,
  encodeAgentMessageDeliveryAck,
  decodeAgentMessageDeliveryAck,
  encodeAgentActivity,
  decodeAgentActivity,
  encodeAgentStatus,
  decodeAgentStatus,
  validateAgentMessageRequest,
} from "./codec";
export * from "./agent-skills";
export * from "./agent-workspace-files";
export * from "./agent-control";
export * from "./agent-migration";
export * from "./reminder";
export * from "./app-config";
export * from "./tasks";
export * from "./task-codec";
export * from "./channel-command";
export * from "./agent-display";
export * from "./service-tier";
export * from "./message-sender";
export * from "./agent-name";
export * from "./daemon-connect-rejection";
export * from "./weekly-report-limits";
export * from "./weekly-report-memory";
export * from "./codec";
export * from "./message-references";
export * from "./utility-exports";
export * from "./tool-display";
export * from "./attachment-limits";
export * from "./mime-type";
export * from "./json-record";
export * from "./agent-environment";
export * from "./mention-delivery";

export {
  weeklyReportWorkflowSchema,
  type WeeklyReportWorkflowAction,
} from "./weekly-report-workflow";
export * from "./daemon-shutdown";
