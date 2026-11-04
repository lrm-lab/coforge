import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
  DaemonRuntimeReadyRequestSchema,
  DaemonRuntimeReadyResponseSchema,
} from "./gen/coforge/rpc/v1/daemon_runtime_pb";
import type { DaemonRuntimeReadyRequest, DaemonRuntimeReadyResponse } from "./index";

function assertRunningAgentIds(agentIds: readonly string[]): void {
  if (agentIds.some((agentId) => !agentId) || new Set(agentIds).size !== agentIds.length)
    throw new Error("Daemon running Agent IDs must be non-empty and unique");
}
export function encodeDaemonRuntimeReadyRequest(value: DaemonRuntimeReadyRequest): Uint8Array {
  assertRunningAgentIds(value.runningAgentIds);
  return toBinary(
    DaemonRuntimeReadyRequestSchema,
    create(DaemonRuntimeReadyRequestSchema, {
      ...value,
      startedAt: BigInt(value.startedAt),
    }),
  );
}

export function decodeDaemonRuntimeReadyRequest(bytes: Uint8Array): DaemonRuntimeReadyRequest {
  const value = fromBinary(DaemonRuntimeReadyRequestSchema, bytes);
  assertRunningAgentIds(value.runningAgentIds);
  return {
    protocolMajor: value.protocolMajor,
    requestId: value.requestId,
    workspaceId: value.workspaceId,
    computerId: value.computerId,
    workerInstanceId: value.workerInstanceId,
    daemonVersion: value.daemonVersion,
    ...(value.computerVersion !== undefined ? { computerVersion: value.computerVersion } : {}),
    ...(value.platform !== undefined ? { platform: value.platform } : {}),
    ...(value.osVersion !== undefined ? { osVersion: value.osVersion } : {}),
    startedAt: Number(value.startedAt),
    runningAgentIds: [...value.runningAgentIds],
    recoveredRestartRequestIds: [...value.recoveredRestartRequestIds],
    recoveredUpgradeRequestIds: [...value.recoveredUpgradeRequestIds],
    ...(value.capabilities.length ? { capabilities: [...value.capabilities] } : {}),
  };
}

export function encodeDaemonRuntimeReadyResponse(value: DaemonRuntimeReadyResponse): Uint8Array {
  return toBinary(
    DaemonRuntimeReadyResponseSchema,
    create(DaemonRuntimeReadyResponseSchema, value),
  );
}

/** The server's ready reply; an older server answers empty bytes, which read as no version. */
export function decodeDaemonRuntimeReadyResponse(bytes: Uint8Array): DaemonRuntimeReadyResponse {
  if (!bytes.length) return {};
  return fromBinary(DaemonRuntimeReadyResponseSchema, bytes);
}
