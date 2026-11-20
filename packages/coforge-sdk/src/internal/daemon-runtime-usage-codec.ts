import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
  DaemonRuntimeUsageScanRequestSchema,
  DaemonRuntimeUsageScanResponseSchema,
} from "#src/internal/gen/coforge/rpc/v1/daemon_runtime_pb";
import {
  RUNTIME_PROVIDER,
  USAGE_SCAN_MESSAGE_TYPE,
  USAGE_SCAN_RESPONSE_MESSAGE_TYPE,
} from "./index";
import type {
  DaemonRuntimeUsageScanRequest,
  DaemonRuntimeUsageScanResponse,
} from "./computer-agent-messages";

function assertAgentUsageScope(provider: string, agentId?: string, revision?: number): void {
  if (agentId === undefined && revision === undefined) return;
  if (
    provider !== RUNTIME_PROVIDER.CODEX ||
    !agentId?.trim() ||
    revision === undefined ||
    !Number.isInteger(revision) ||
    revision < 0 ||
    revision > 2 ** 32 - 1
  )
    throw new Error("invalid Agent usage scan scope");
}

export function encodeDaemonRuntimeUsageScanRequest(v: DaemonRuntimeUsageScanRequest): Uint8Array {
  assertAgentUsageScope(v.provider, v.agentId, v.expectedRuntimeConfigRevision);
  return toBinary(
    DaemonRuntimeUsageScanRequestSchema,
    create(DaemonRuntimeUsageScanRequestSchema, { ...v, messageType: USAGE_SCAN_MESSAGE_TYPE }),
  );
}
export function decodeDaemonRuntimeUsageScanRequest(
  bytes: Uint8Array,
): DaemonRuntimeUsageScanRequest {
  const v = fromBinary(DaemonRuntimeUsageScanRequestSchema, bytes);
  if (v.messageType !== USAGE_SCAN_MESSAGE_TYPE)
    throw new Error("invalid daemon runtime message type");
  assertAgentUsageScope(v.provider, v.agentId, v.expectedRuntimeConfigRevision);
  return {
    protocolMajor: v.protocolMajor,
    requestId: v.requestId,
    workspaceId: v.workspaceId,
    computerId: v.computerId,
    provider: v.provider as import("./index").RuntimeProvider,
    messageType: v.messageType,
    ...(v.agentId !== undefined && {
      agentId: v.agentId,
      expectedRuntimeConfigRevision: v.expectedRuntimeConfigRevision,
    }),
  };
}
export function encodeDaemonRuntimeUsageScanResponse(
  v: DaemonRuntimeUsageScanResponse,
): Uint8Array {
  assertAgentUsageScope(v.provider, v.agentId, v.effectiveRuntimeConfigRevision);
  return toBinary(
    DaemonRuntimeUsageScanResponseSchema,
    create(DaemonRuntimeUsageScanResponseSchema, {
      ...v,
      messageType: USAGE_SCAN_RESPONSE_MESSAGE_TYPE,
    }),
  );
}
export function decodeDaemonRuntimeUsageScanResponse(
  bytes: Uint8Array,
): DaemonRuntimeUsageScanResponse {
  const v = fromBinary(DaemonRuntimeUsageScanResponseSchema, bytes);
  if (v.messageType !== USAGE_SCAN_RESPONSE_MESSAGE_TYPE)
    throw new Error("invalid daemon runtime message type");
  assertAgentUsageScope(v.provider, v.agentId, v.effectiveRuntimeConfigRevision);
  return {
    protocolMajor: v.protocolMajor,
    requestId: v.requestId,
    workspaceId: v.workspaceId,
    computerId: v.computerId,
    provider: v.provider as import("./index").RuntimeProvider,
    accepted: v.accepted,
    status: v.status,
    message: v.message || undefined,
    snapshotJson: v.snapshotJson.length ? v.snapshotJson : undefined,
    messageType: v.messageType,
    ...(v.agentId !== undefined && {
      agentId: v.agentId,
      effectiveRuntimeConfigRevision: v.effectiveRuntimeConfigRevision,
    }),
  };
}
