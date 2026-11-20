import type { AgentMessageDelivery } from "./agent-message-delivery";
import type { RuntimeProvider } from "./runtime-provider";
import type {
  AGENT_MESSAGE_ACK_METHOD,
  AGENT_MESSAGE_REJECT_METHOD,
  AGENT_STOP_MESSAGE_TYPE,
  AgentDeliveryRejectionReason,
  AgentInboxPurgeReason,
  AgentRuntimeProviderConfig,
  COMPUTER_RESTART_MESSAGE_TYPE,
  COMPUTER_UPGRADE_MESSAGE_TYPE,
  COMPUTER_UPGRADE_RESULT_MESSAGE_TYPE,
  DaemonRuntimeMessageType,
} from "./index";
export type RuntimeUnavailableCode =
  | "version_unsupported"
  | "start_failed"
  | "probe_failed"
  | "unknown";
export type RuntimeMetadata = {
  provider: RuntimeProvider;
  version: string;
  displayName: string;
  unavailableCode?: RuntimeUnavailableCode;
  diagnostic?: string;
};
export type CodeAgentModelMetadata = {
  id: string;
  displayName: string;
  description: string;
  modelProvider: string;
  reasoningEfforts?: string[];
  defaultReasoning: string;
  recommended: boolean;
  contextWindow?: number;
  maxOutputTokens?: number;
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
  adoptComputerId?: string;
  fresh?: boolean;
};
export type ComputerRegisterResponse = {
  protocolMajor: number;
  requestId: string;
  computerId: string;
  workspaceId: string;
  daemonApiKey: string;
  workspaceSlug?: string;
};
export type ComputerCandidate = {
  computerId: string;
  machineId: string;
  name: string;
  displayName: string;
  platform: string;
  osVersion: string;
  computerVersion: string;
  workspaceSlugs: string[];
  lastSeenAt?: string;
};
export type ComputerListRequest = {
  protocolMajor: number;
  requestId: string;
};
export type ComputerListResponse = {
  protocolMajor: number;
  requestId: string;
  computers: ComputerCandidate[];
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
  releaseChannel?: string;
  appliedAgentConfigs?: Array<{
    agentId: string;
    revision: number;
  }>;
};
export type DaemonRuntimeReadyResponse = {
  latestComputerVersion?: string;
  agentControlAccepted?: boolean;
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
  releaseChannel?: string;
  messageType?: typeof COMPUTER_UPGRADE_MESSAGE_TYPE;
};
export type ComputerUpgradeResult = {
  protocolMajor: number;
  requestId: string;
  workspaceId: string;
  computerId: string;
  status: "succeeded" | "failed";
  completedAtMs: number;
  version?: string;
  error?: string;
  errorCode?: string;
  deadProcessCount?: number;
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
  agentId?: string;
  expectedRuntimeConfigRevision?: number;
};
export type DaemonRuntimeUsageScanResponse = Omit<
  DaemonRuntimeUsageScanRequest,
  "expectedRuntimeConfigRevision"
> & {
  effectiveRuntimeConfigRevision?: number;
  accepted: boolean;
  status: string;
  message?: string;
  snapshotJson?: Uint8Array;
};
export type DaemonRuntimeProviderModelRefreshRequest = {
  protocolMajor: number;
  requestId: string;
  workspaceId: string;
  computerId: string;
  provider?: RuntimeProvider;
  messageType?: DaemonRuntimeMessageType;
};
export type ProviderModelRefreshResult = {
  provider: RuntimeProvider;
  status: "refreshed" | "error";
  code?: RuntimeUnavailableCode;
  diagnostic?: string;
  catalog?: CodeAgentModelCatalog;
};
export type DaemonRuntimeProviderModelRefreshResponse = Omit<
  DaemonRuntimeProviderModelRefreshRequest,
  "provider"
> & {
  accepted: boolean;
  results: ProviderModelRefreshResult[];
};
export type DaemonRuntimeCommandCodeEffortReadRequest = {
  protocolMajor: number;
  requestId: string;
  workspaceId: string;
  computerId: string;
  modelId: string;
  messageType?: DaemonRuntimeMessageType;
};
export type DaemonRuntimeCommandCodeEffortReadResponse = {
  protocolMajor: number;
  requestId: string;
  workspaceId: string;
  computerId: string;
  accepted: boolean;
  status: string;
  efforts: string[];
  messageType?: DaemonRuntimeMessageType;
};
export const AGENT_START_OPEN_TASKS_MAX = 20;
export type AgentStartOpenTaskStatus = "todo" | "in_progress";
export type AgentStartOpenTask = {
  ref: string;
  title: string;
  status: AgentStartOpenTaskStatus;
};
export type AgentStartOpenTasks = {
  tasks: AgentStartOpenTask[];
  more: number;
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
  launchId?: string;
  providerConfig?: AgentRuntimeProviderConfig;
  wakeMessage?: AgentRecoveryMessage;
  resumeMessages?: AgentRecoveryMessage[];
  unreadSummary?: Readonly<Record<string, number>>;
  unreadConversationIds?: Readonly<Record<string, string>>;
  openTasks?: AgentStartOpenTasks;
  resumePrompt?: string;
  introductionPrompt?: string;
  fastMode?: boolean;
  agentConfigRevision?: number;
  contextWindow?: number;
  maxOutputTokens?: number;
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
export type AgentActivityProbe = {
  protocolMajor: number;
  requestId: string;
  workspaceId: string;
  computerId: string;
  agentId: string;
  probeId: string;
};
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
  messageId: string;
  deliveryId: string;
  conversationId: string;
  sequence: number;
  target: string;
  latestSenderKind: import("./message-sender").MessageSenderKind;
  latestSenderHandle: string;
  latestSenderDescription: string;
  body: string;
  nonMemberMention?: boolean;
  createdAtMs?: number;
};
export type AgentMessageDeliveryAck = Omit<
  AgentMessageDelivery,
  "body" | "conversationId" | "createdAtMs" | "method" | "requestId"
> & {
  method: typeof AGENT_MESSAGE_ACK_METHOD;
  requestId: string;
};
export type AgentMessageDeliveryRejection = Omit<AgentMessageDeliveryAck, "method"> & {
  method: typeof AGENT_MESSAGE_REJECT_METHOD;
  reason: AgentDeliveryRejectionReason;
};
