import { RPC_METHODS } from "./rpc-methods";
import type { ComputerRegisterRequest, ComputerRegisterResponse } from "./computer-agent-messages";
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
export const DAEMON_RUNTIME_EFFORT_READ_METHOD = RPC_METHODS.daemonEffortRead;
export const DAEMON_RUNTIME_EFFORT_READ_RESULT_METHOD = RPC_METHODS.daemonEffortReadResult;
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
export const COMMAND_CODE_EFFORT_READ_MESSAGE_TYPE =
  "coforge.rpc.v1.DaemonRuntimeCommandCodeEffortReadRequest" as const;
export const COMMAND_CODE_EFFORT_READ_RESPONSE_MESSAGE_TYPE =
  "coforge.rpc.v1.DaemonRuntimeCommandCodeEffortReadResponse" as const;
export type DaemonRuntimeMessageType =
  | typeof AGENT_START_MESSAGE_TYPE
  | typeof AGENT_STOP_MESSAGE_TYPE
  | typeof USAGE_SCAN_MESSAGE_TYPE
  | typeof USAGE_SCAN_RESPONSE_MESSAGE_TYPE
  | typeof MODEL_REFRESH_MESSAGE_TYPE
  | typeof MODEL_REFRESH_RESPONSE_MESSAGE_TYPE
  | typeof COMMAND_CODE_EFFORT_READ_MESSAGE_TYPE
  | typeof COMMAND_CODE_EFFORT_READ_RESPONSE_MESSAGE_TYPE;
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
export { threadParentTarget, threadRootTarget } from "./message-thread-target";
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
export * from "./agent-reports";
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
  "repair",
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
export * from "./computer-agent-messages";
export {
  decodeDaemonRuntimeCommandCodeEffortReadRequest,
  decodeDaemonRuntimeCommandCodeEffortReadResponse,
  encodeDaemonRuntimeCommandCodeEffortReadRequest,
  encodeDaemonRuntimeCommandCodeEffortReadResponse,
} from "./command-code-effort-codec";
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
} from "./local-daemon";
export * from "./runner-hold";
export * from "./usage-scan";
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
  encodeAgentMessageDeliveryAck,
  decodeAgentMessageDeliveryAck,
  encodeAgentActivity,
  decodeAgentActivity,
  encodeAgentStatus,
  decodeAgentStatus,
  validateAgentMessageRequest,
} from "./codec";
export * from "./agent-message-delivery";
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
