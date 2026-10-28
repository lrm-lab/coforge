// Computer and Agent request, intent, and delivery message types of the daemon RPC.

import type { MemoryAgentToolProfile } from "../agent/memory-tool-fences";
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
  /** Absent while the runtime has not yet read this model's levels (Devin's sweep). */
  reasoningEfforts?: string[];
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
/** Server -> daemon. Read one Command Code model's effort choices after the user selects it. */
export type DaemonRuntimeCommandCodeEffortReadRequest = {
  protocolMajor: number;
  requestId: string;
  workspaceId: string;
  computerId: string;
  modelId: string;
  messageType?: DaemonRuntimeMessageType;
};
/** Daemon -> server. `status` is `ready` or `failed`. `efforts` never includes `default`. */
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
  /** When the server created the message, in epoch milliseconds; unset from an older server. */
  createdAtMs?: number;
};
export type AgentMessageDeliveryAck = Omit<
  AgentMessageDelivery,
  "body" | "conversationId" | "createdAtMs" | "method" | "requestId"
> & { method: typeof AGENT_MESSAGE_ACK_METHOD; requestId: string };
/** Versioned daemon-to-server rejection of a delivery: never an ACK, so the delivery stays unread. */
export type AgentMessageDeliveryRejection = Omit<AgentMessageDeliveryAck, "method"> & {
  method: typeof AGENT_MESSAGE_REJECT_METHOD;
  reason: AgentDeliveryRejectionReason;
};
