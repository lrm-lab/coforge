import { memoryHintMessage, readMemoryHint } from "./memory-hint";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
  DaemonHandshakeRequestSchema,
  DaemonHandshakeResponseSchema,
  DaemonCommandRequestSchema,
  DaemonCommandResponseSchema,
} from "#src/internal/gen/coforge/rpc/v1/daemon_pb";
import {
  DaemonRuntimeConfigureRequestSchema,
  DaemonRuntimeConfigureResponseSchema,
} from "#src/internal/gen/coforge/rpc/v1/daemon_runtime_pb";
import {
  LocalRpcRequestSchema,
  LocalRpcResponseSchema,
  AgentMessageResponseSchema,
} from "#src/internal/gen/coforge/rpc/v1/local_rpc_pb";
import { assertValidMessageSender } from "./message-sender";
import {
  decodeMessageAttentionSummary,
  encodeMessageAttentionSummary,
  type MessageAttentionSummary,
} from "./local-attention-summary";
import { fromWireRequestId, toWireRequestId } from "./idempotency-key-wire";

export const LOCAL_RPC_PROTOCOL_MAJOR = 1 as const;
export const LOCAL_RPC_METHODS = {
  HANDSHAKE: "daemon:handshake",
  CONFIGURE: "daemon-runtime:configure",
  START: "daemon:start",
  STOP: "daemon:stop",
  RESTART: "daemon:restart",
  SNAPSHOT: "daemon:snapshot",
  UPGRADE: "daemon:upgrade",
  UPGRADE_ACKNOWLEDGE: "daemon:upgrade_ack",
  HOLD: "daemon:hold",
  RELEASE: "daemon:release",
  AGENT_INBOX: "agent:inbox",
  USAGE_SCAN: "usage:scan",
} as const;
export * from "./local-inbox";
export * from "./local-attention-summary";
/** A structured @mention binding: a handle claimed to name a specific actor. */
export type LocalMentionSelector = { type: "user" | "agent"; id: string; name: string };

/** What a `message search` request asks for beyond the filters every message request shares. */
export type LocalMessageSearchFields = {
  query?: string;
  sender?: string;
  sort?: "relevance" | "recent";
  /** Skips this many results; pages a `relevance` search. */
  offset?: number;
  /** A previous page's `nextCursor`; continues a `recent` search with a query. */
  cursor?: string;
};
export type LocalAgentMessageRequest = LocalMessageSearchFields & {
  idempotencyKey: string;
  context: string;
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
  target?: string;
  content?: string;
  /** Alias of `content`, used only when `content` is absent. Never forwarded upstream. */
  message?: string;
  sendDraft?: boolean;
  /** `message send --send-draft` only: refuse, before any request, unless the saved draft still
   * belongs to the logical send with this idempotency key. */
  expectedDraftKey?: string;
  continueAnyway?: boolean;
  /** `message send` only (daemon-internal): the boundary the sender has already reviewed. */
  seenUpToSeq?: number;
  /** `message send` only (daemon-internal): how many times this draft has already been held. */
  draftReholdCount?: number;
  /** `message send` only (daemon-internal): a normal send that replaced an already-held draft. */
  draftReplacedExisting?: boolean;
  before?: string;
  after?: string;
  around?: string;
  limit?: number;
  unread?: boolean;
  freshnessContextMode?: "inline" | "withheld";
  messageId?: string;
  emoji?: string;
  /** `message send` only: attachments already uploaded to this conversation, in send order.
   * Max 10, unique, each a UUID. */
  attachmentIds?: string[];
  /** `message send` only: structured @mention bindings; replaces the draft's saved mentions on `--send-draft` when non-empty. */
  mentions?: LocalMentionSelector[];
  /** `message send` only: confirms a top-level send despite newer thread read context under the same parent. Never leaves the daemon. */
  targetConfirmed?: boolean;
};
import type {
  AgentMessageRecord,
  LocalAttachment,
  MessageTaskMetadata,
} from "./agent-message-record";

export type {
  AgentMessageRecord,
  LocalAttachment,
  MessageTaskMetadata,
} from "./agent-message-record";

export function decodeMessageTask(value: {
  number: number;
  status: string;
  owner?: { displayName: string; handle: string; deleted?: boolean };
}): MessageTaskMetadata {
  let status: MessageTaskMetadata["status"];
  switch (value.status) {
    case "todo":
    case "in_progress":
    case "in_review":
    case "done":
    case "closed":
      status = value.status;
      break;
    default:
      throw new Error("invalid message Task status");
  }
  return {
    number: value.number,
    status,
    ...(value.owner
      ? {
          owner: {
            displayName: value.owner.displayName,
            handle: value.owner.handle,
            ...(value.owner.deleted ? { deleted: true } : {}),
          },
        }
      : {}),
  };
}
export function encodeLocalAttachment(value: LocalAttachment) {
  return { ...value, sizeBytes: BigInt(value.sizeBytes) };
}
export function encodeLocalAttachments(values: readonly LocalAttachment[]) {
  return values.map(encodeLocalAttachment);
}
type RawLocalAttachment = {
  id: string;
  fileName: string;
  contentType: string;
  sizeBytes: bigint;
};
export function decodeLocalAttachments(values: readonly RawLocalAttachment[]): LocalAttachment[] {
  return values.map((value) => ({
    id: value.id,
    fileName: value.fileName,
    contentType: value.contentType,
    sizeBytes: Number(value.sizeBytes),
  }));
}
/** One mention the sender's message did not deliver, as the send reports it. */
import type {
  AgentMessageResponse,
  AgentPendingMentionAction,
  LocalSearchPaging,
} from "./agent-message-response";
export type { AgentMessageResponse, AgentPendingMentionAction, LocalSearchPaging };

function encodeAgentMessageRecords(records: readonly AgentMessageRecord[]) {
  for (const m of records)
    assertValidMessageSender(m.senderKind, m.senderHandle, "Agent message record");
  return records.map((m) => ({
    ...m,
    sequence: BigInt(m.sequence),
    createdAt: m.createdAt,
    attachments: encodeLocalAttachments(m.attachments),
    task: m.task,
    memoryHint: memoryHintMessage(m.memoryHint),
  }));
}

function decodeAgentMessageRecords(
  records: readonly {
    id: string;
    sequence: bigint;
    senderKind: string;
    senderHandle: string;
    senderDescription: string;
    target: string;
    body: string;
    createdAt: string;
    attachments: readonly RawLocalAttachment[];
    task?: Parameters<typeof decodeMessageTask>[0];
    mentionsAgent?: boolean;
    memoryHint?: { hintId: string; tool: string };
  }[],
): AgentMessageRecord[] {
  return records.map((m) => {
    assertValidMessageSender(m.senderKind, m.senderHandle, "Agent message record");
    return {
      id: m.id,
      sequence: Number(m.sequence),
      senderKind: m.senderKind,
      senderHandle: m.senderHandle,
      senderDescription: m.senderDescription,
      target: m.target,
      body: m.body,
      createdAt: m.createdAt,
      attachments: decodeLocalAttachments(m.attachments),
      ...(m.task ? { task: decodeMessageTask(m.task) } : {}),
      ...(m.mentionsAgent ? { mentionsAgent: true } : {}),
      ...(m.memoryHint ? { memoryHint: readMemoryHint(m.memoryHint) } : {}),
    };
  });
}

export function encodeAgentMessageResponse(value: AgentMessageResponse): Uint8Array {
  const safeValue =
    value.freshnessContextMode === "withheld"
      ? {
          ...value,
          messages: [],
          summaries: [],
          hasOlder: undefined,
          hasNewer: undefined,
          olderCursor: undefined,
          newerCursor: undefined,
          withheldMessageCount: value.withheldMessageCount ?? value.attentionCount,
          hasMore: undefined,
          nextCursor: undefined,
          incomplete: undefined,
          searchedMessages: undefined,
          searchedThrough: undefined,
          heldMessages: [],
          recentUnread: [],
        }
      : value;
  return toBinary(
    AgentMessageResponseSchema,
    create(AgentMessageResponseSchema, {
      ...toWireRequestId(safeValue),
      messages: encodeAgentMessageRecords(safeValue.messages),
      heldMessages: encodeAgentMessageRecords(safeValue.heldMessages ?? []),
      recentUnread: encodeAgentMessageRecords(safeValue.recentUnread ?? []),
      summaries: safeValue.summaries.map(encodeMessageAttentionSummary),
      hasOlder: safeValue.hasOlder ?? false,
      hasNewer: safeValue.hasNewer ?? false,
      olderCursor: safeValue.olderCursor,
      newerCursor: safeValue.newerCursor,
      nextCursor: safeValue.nextCursor,
      incomplete: safeValue.incomplete ?? false,
      searchedMessages: safeValue.searchedMessages,
      searchedThrough: safeValue.searchedThrough,
      unreadCursorBefore:
        safeValue.unreadCursorBefore === undefined
          ? undefined
          : BigInt(safeValue.unreadCursorBefore),
      readPositionAfter:
        safeValue.readPositionAfter === undefined ? undefined : BigInt(safeValue.readPositionAfter),
      moreUnread: safeValue.moreUnread,
      foldedMessageCount: safeValue.foldedMessageCount,
      appItemsPending: safeValue.appItemsPending,
      foldedFromSequence:
        safeValue.foldedFromSequence === undefined
          ? undefined
          : BigInt(safeValue.foldedFromSequence),
      foldedThroughSequence:
        safeValue.foldedThroughSequence === undefined
          ? undefined
          : BigInt(safeValue.foldedThroughSequence),
    }),
  );
}
export function decodeAgentMessageResponse(bytes: Uint8Array): AgentMessageResponse {
  const v = fromBinary(AgentMessageResponseSchema, bytes);
  if (v.freshnessContextMode && !["inline", "withheld"].includes(v.freshnessContextMode))
    throw new Error("invalid Agent message freshness context mode");
  if (v.freshnessContextMode === "withheld")
    return fromWireRequestId({
      requestId: v.requestId,
      accepted: v.accepted,
      attentionCount: v.attentionCount,
      messages: [],
      messageId: v.messageId,
      summaries: [],
      state: v.state as AgentMessageResponse["state"],
      decision: v.decision as AgentMessageResponse["decision"],
      reason: v.reason || undefined,
      producerFactId: v.producerFactId || undefined,
      availableActions: v.availableActions.length ? v.availableActions : undefined,
      continueAnywaySuggested: v.continueAnywaySuggested || undefined,
      heldMessages: [],
      newMessageCount: v.newMessageCount,
      shownMessageCount: v.shownMessageCount,
      omittedMessageCount: v.omittedMessageCount,
      freshnessContextMode: "withheld" as const,
      withheldMessageCount: v.withheldMessageCount ?? v.attentionCount,
      recentUnread: [],
    });
  return fromWireRequestId({
    requestId: v.requestId,
    accepted: v.accepted,
    attentionCount: v.attentionCount,
    messageId: v.messageId,
    summaries: v.summaries.map(decodeMessageAttentionSummary),
    messages: decodeAgentMessageRecords(v.messages),
    state: (v.state || undefined) as AgentMessageResponse["state"],
    decision: (v.decision || undefined) as AgentMessageResponse["decision"],
    reason: v.reason || undefined,
    producerFactId: v.producerFactId || undefined,
    availableActions: v.availableActions.length ? v.availableActions : undefined,
    continueAnywaySuggested: v.continueAnywaySuggested || undefined,
    heldMessages: v.heldMessages.length ? decodeAgentMessageRecords(v.heldMessages) : undefined,
    newMessageCount: v.newMessageCount,
    shownMessageCount: v.shownMessageCount,
    omittedMessageCount: v.omittedMessageCount,
    recentUnread: v.recentUnread.length ? decodeAgentMessageRecords(v.recentUnread) : undefined,
    hasOlder: v.hasOlder || undefined,
    hasNewer: v.hasNewer || undefined,
    olderCursor: v.olderCursor || undefined,
    newerCursor: v.newerCursor || undefined,
    unreadCursorBefore:
      v.unreadCursorBefore === undefined ? undefined : Number(v.unreadCursorBefore),
    readPositionAfter: v.readPositionAfter === undefined ? undefined : Number(v.readPositionAfter),
    moreUnread: v.moreUnread,
    foldedMessageCount: v.foldedMessageCount,
    appItemsPending: v.appItemsPending,
    foldedFromSequence:
      v.foldedFromSequence === undefined ? undefined : Number(v.foldedFromSequence),
    foldedThroughSequence:
      v.foldedThroughSequence === undefined ? undefined : Number(v.foldedThroughSequence),
    freshnessContextMode: (v.freshnessContextMode || undefined) as
      | "inline"
      | "withheld"
      | undefined,
    withheldMessageCount: v.withheldMessageCount,
    hasMore: v.hasMore || undefined,
    nextCursor: v.nextCursor || undefined,
    incomplete: v.incomplete || undefined,
    searchedMessages: v.searchedMessages,
    searchedThrough: v.searchedThrough || undefined,
  });
}
export const DAEMON_HANDSHAKE_METHOD = LOCAL_RPC_METHODS.HANDSHAKE;
export const DAEMON_RUNTIME_CONFIGURE_METHOD = LOCAL_RPC_METHODS.CONFIGURE;
export type DaemonRuntimeConfigureRequest = {
  protocolMajor: number;
  requestId: string;
  workspaceId: string;
  workspaceRoot: string;
  daemonApiKey: string;
  computerId: string;
  expectedServerUrl: string;
  serverHttpUrl?: string;
};
export type DaemonRuntimeConfigureResponse = {
  protocolMajor: number;
  requestId: string;
  accepted: boolean;
  /** Taken, but the Workspace's start was still under way when the Coordinator answered. */
  lifecycleUnderWay?: boolean;
};
export type DaemonCommandRequest = {
  protocolMajor: number;
  requestId: string;
  expectedServerUrl: string;
  workspaceId?: string;
  expectedVersion?: string;
};
/** Where a Workspace daemon's latest cloud connect stands. */
export const WORKSPACE_CLOUD_CONNECTION_STATES = [
  "connecting",
  "connected",
  "not_connected",
] as const;
export type WorkspaceCloudConnection = (typeof WORKSPACE_CLOUD_CONNECTION_STATES)[number];

function cloudConnection(value: string | undefined): WorkspaceCloudConnection | undefined {
  return WORKSPACE_CLOUD_CONNECTION_STATES.find((state) => state === value);
}

export type ManagedRuntimeIdentity = {
  workspaceId: string;
  computerId: string;
  enabled: boolean;
  processId: number;
  instanceId: string;
  version: string;
  /** Why the cloud refused this Workspace for good, when it is parked. */
  parkReason?: string;
  /** Only on the Workspaces an operator start or restart just started. */
  cloudConnection?: WorkspaceCloudConnection;
  cloudConnectionError?: string;
  /** A start, restart, or configure of this Workspace is queued or running in the Coordinator. */
  lifecycleUnderWay?: boolean;
};
export type DaemonCommandResponse = {
  protocolMajor: number;
  requestId: string;
  accepted: boolean;
  runtimes?: ManagedRuntimeIdentity[];
  /** Set only when `accepted` is false. Local Coordinator<->Workspace daemon process boundary
   * only - never the wire to the server. */
  error?: string;
  /** See `UPGRADE_ERROR_CODE` (the only vocabulary a lifecycle refusal currently uses); may be
   * absent even when `error` is set, and may name a code this build does not know yet. */
  errorCode?: string;
  /** The Workspace a refusal is about, when it is about one (a parked Workspace). */
  workspaceId?: string;
};
export type LocalRpcRequest = { method: string; payload: Uint8Array };
export type LocalRpcResponse = { method: string; payload: Uint8Array };

export function encodeLocalRpcRequest(value: LocalRpcRequest): Uint8Array {
  return toBinary(LocalRpcRequestSchema, create(LocalRpcRequestSchema, value));
}
export function decodeLocalRpcRequest(bytes: Uint8Array): LocalRpcRequest {
  const value = fromBinary(LocalRpcRequestSchema, bytes);
  return { method: value.method, payload: value.payload };
}
export function encodeLocalRpcResponse(value: LocalRpcResponse): Uint8Array {
  return toBinary(LocalRpcResponseSchema, create(LocalRpcResponseSchema, value));
}
export function decodeLocalRpcResponse(bytes: Uint8Array): LocalRpcResponse {
  const value = fromBinary(LocalRpcResponseSchema, bytes);
  return { method: value.method, payload: value.payload };
}

export function encodeDaemonRuntimeConfigureRequest(
  value: DaemonRuntimeConfigureRequest,
): Uint8Array {
  return toBinary(
    DaemonRuntimeConfigureRequestSchema,
    create(DaemonRuntimeConfigureRequestSchema, value),
  );
}
export function decodeDaemonRuntimeConfigureRequest(
  bytes: Uint8Array,
): DaemonRuntimeConfigureRequest {
  const v = fromBinary(DaemonRuntimeConfigureRequestSchema, bytes);
  return {
    protocolMajor: v.protocolMajor,
    requestId: v.requestId,
    workspaceId: v.workspaceId,
    workspaceRoot: v.workspaceRoot,
    daemonApiKey: v.daemonApiKey,
    computerId: v.computerId,
    expectedServerUrl: v.expectedServerUrl,
    serverHttpUrl: v.serverHttpUrl,
  };
}
export function encodeDaemonRuntimeConfigureResponse(
  value: DaemonRuntimeConfigureResponse,
): Uint8Array {
  return toBinary(
    DaemonRuntimeConfigureResponseSchema,
    create(DaemonRuntimeConfigureResponseSchema, value),
  );
}
export function decodeDaemonRuntimeConfigureResponse(
  bytes: Uint8Array,
): DaemonRuntimeConfigureResponse {
  const v = fromBinary(DaemonRuntimeConfigureResponseSchema, bytes);
  return {
    protocolMajor: v.protocolMajor,
    requestId: v.requestId,
    accepted: v.accepted,
    ...(v.lifecycleUnderWay ? { lifecycleUnderWay: true } : {}),
  };
}

export function encodeDaemonCommandRequest(value: DaemonCommandRequest): Uint8Array {
  return toBinary(DaemonCommandRequestSchema, create(DaemonCommandRequestSchema, value));
}
export function decodeDaemonCommandRequest(bytes: Uint8Array): DaemonCommandRequest {
  const value = fromBinary(DaemonCommandRequestSchema, bytes);
  return {
    protocolMajor: value.protocolMajor,
    requestId: value.requestId,
    expectedServerUrl: value.expectedServerUrl,
    workspaceId: value.workspaceId,
    expectedVersion: value.expectedVersion,
  };
}
export function encodeDaemonCommandResponse(value: DaemonCommandResponse): Uint8Array {
  return toBinary(DaemonCommandResponseSchema, create(DaemonCommandResponseSchema, value));
}
export function decodeDaemonCommandResponse(bytes: Uint8Array): DaemonCommandResponse {
  const value = fromBinary(DaemonCommandResponseSchema, bytes);
  return {
    protocolMajor: value.protocolMajor,
    requestId: value.requestId,
    accepted: value.accepted,
    runtimes: value.runtimes.map((runtime) => ({
      workspaceId: runtime.workspaceId,
      computerId: runtime.computerId,
      enabled: runtime.enabled,
      processId: runtime.processId,
      instanceId: runtime.instanceId,
      version: runtime.version,
      ...(runtime.parkReason ? { parkReason: runtime.parkReason } : {}),
      ...connectionFields(runtime),
      ...(runtime.lifecycleUnderWay ? { lifecycleUnderWay: true } : {}),
    })),
    ...(value.error ? { error: value.error } : {}),
    ...(value.errorCode ? { errorCode: value.errorCode } : {}),
    ...(value.workspaceId ? { workspaceId: value.workspaceId } : {}),
  };
}

export type DaemonHandshakeRequest = {
  protocolMajor: number;
  requestId: string;
};

export type DaemonHandshakeResponse = {
  protocolMajor: number;
  requestId: string;
  daemonId: string;
  accepted: boolean;
  serverUrl: string;
  version?: string;
  processId?: number;
  /** Where the Workspace daemon's latest cloud connect stands. */
  cloudConnection?: WorkspaceCloudConnection;
  cloudConnectionError?: string;
};

export function encodeDaemonHandshakeRequest(value: DaemonHandshakeRequest): Uint8Array {
  return toBinary(DaemonHandshakeRequestSchema, create(DaemonHandshakeRequestSchema, value));
}

export function decodeDaemonHandshakeRequest(bytes: Uint8Array): DaemonHandshakeRequest {
  const value = fromBinary(DaemonHandshakeRequestSchema, bytes);
  return {
    protocolMajor: value.protocolMajor,
    requestId: value.requestId,
  };
}

export function encodeDaemonHandshakeResponse(value: DaemonHandshakeResponse): Uint8Array {
  return toBinary(DaemonHandshakeResponseSchema, create(DaemonHandshakeResponseSchema, value));
}

export function decodeDaemonHandshakeResponse(bytes: Uint8Array): DaemonHandshakeResponse {
  const value = fromBinary(DaemonHandshakeResponseSchema, bytes);
  return {
    protocolMajor: value.protocolMajor,
    requestId: value.requestId,
    daemonId: value.daemonId,
    accepted: value.accepted,
    serverUrl: value.serverUrl,
    version: value.version || undefined,
    processId: value.processId || undefined,
    ...connectionFields(value),
  };
}

export function frameLocalRpc(payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(4 + payload.byteLength);
  new DataView(frame.buffer).setUint32(0, payload.byteLength);
  frame.set(payload, 4);
  return frame;
}

export function readLocalRpcFrame(buffer: Uint8Array): Uint8Array | null {
  if (buffer.byteLength < 4) return null;
  const size = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength).getUint32(0);
  if (buffer.byteLength < size + 4) return null;
  return buffer.slice(4, size + 4);
}

export function readLocalRpcFrames(buffer: Uint8Array): {
  frames: Uint8Array[];
  remainder: Uint8Array;
} {
  const frames: Uint8Array[] = [];
  let remainder = buffer;
  while (true) {
    const frame = readLocalRpcFrame(remainder);
    if (!frame) break;
    frames.push(frame);
    remainder = remainder.slice(frame.byteLength + 4);
  }
  return { frames, remainder };
}

function connectionFields(value: { cloudConnection?: string; cloudConnectionError?: string }) {
  const state = cloudConnection(value.cloudConnection);
  return {
    ...(state ? { cloudConnection: state } : {}),
    ...(value.cloudConnectionError ? { cloudConnectionError: value.cloudConnectionError } : {}),
  };
}
