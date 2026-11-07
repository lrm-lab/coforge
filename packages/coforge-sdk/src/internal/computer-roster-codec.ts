import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
  ComputerListRequestSchema,
  ComputerListResponseSchema,
  ComputerRegisterRequestSchema,
  ComputerRegisterResponseSchema,
} from "#src/internal/gen/coforge/rpc/v1/computer_pb";
import type {
  ComputerCandidate,
  ComputerListRequest,
  ComputerListResponse,
  ComputerRegisterRequest,
  ComputerRegisterResponse,
} from "./index";

// This adapter is intentionally limited to the domain boundary: generated
// messages already use camelCase, while the domain narrows provider values and
// maps legacy/unknown enum zero values to the historical external meaning.
export function encodeComputerRegisterRequest(value: ComputerRegisterRequest): Uint8Array {
  return toBinary(
    ComputerRegisterRequestSchema,
    create(ComputerRegisterRequestSchema, {
      ...value,
    }),
  );
}

export function decodeComputerRegisterRequest(bytes: Uint8Array): ComputerRegisterRequest {
  const value = fromBinary(ComputerRegisterRequestSchema, bytes);
  return {
    protocolMajor: value.protocolMajor,
    requestId: value.requestId,
    workspaceSlug: value.workspaceSlug,
    name: value.name,
    displayName: value.displayName,
    machineId: value.machineId,
    platform: value.platform,
    osVersion: value.osVersion,
    computerVersion: value.computerVersion,
    registrationIdempotencyKey: value.registrationIdempotencyKey,
    adoptComputerId: value.adoptComputerId || undefined,
    fresh: value.fresh || undefined,
  };
}

export function decodeComputerRegisterResponse(bytes: Uint8Array): ComputerRegisterResponse {
  const value = fromBinary(ComputerRegisterResponseSchema, bytes);
  return {
    protocolMajor: value.protocolMajor,
    requestId: value.requestId,
    computerId: value.computerId,
    workspaceId: value.workspaceId,
    daemonApiKey: value.daemonApiKey,
    workspaceSlug: value.workspaceSlug || undefined,
  };
}

export function encodeComputerRegisterResponse(value: ComputerRegisterResponse): Uint8Array {
  return toBinary(ComputerRegisterResponseSchema, create(ComputerRegisterResponseSchema, value));
}

export function encodeComputerListRequest(value: ComputerListRequest): Uint8Array {
  return toBinary(ComputerListRequestSchema, create(ComputerListRequestSchema, value));
}

export function decodeComputerListRequest(bytes: Uint8Array): ComputerListRequest {
  const value = fromBinary(ComputerListRequestSchema, bytes);
  return { protocolMajor: value.protocolMajor, requestId: value.requestId };
}

const computerCandidate = (value: {
  computerId: string;
  machineId: string;
  name: string;
  displayName: string;
  platform: string;
  osVersion: string;
  computerVersion: string;
  workspaceSlugs: string[];
  lastSeenAt?: string;
}): ComputerCandidate => ({
  computerId: value.computerId,
  machineId: value.machineId,
  name: value.name,
  displayName: value.displayName,
  platform: value.platform,
  osVersion: value.osVersion,
  computerVersion: value.computerVersion,
  workspaceSlugs: [...value.workspaceSlugs],
  ...(value.lastSeenAt ? { lastSeenAt: value.lastSeenAt } : {}),
});

export function decodeComputerListResponse(bytes: Uint8Array): ComputerListResponse {
  const value = fromBinary(ComputerListResponseSchema, bytes);
  return {
    protocolMajor: value.protocolMajor,
    requestId: value.requestId,
    computers: value.computers.map(computerCandidate),
  };
}

export function encodeComputerListResponse(value: ComputerListResponse): Uint8Array {
  return toBinary(
    ComputerListResponseSchema,
    create(ComputerListResponseSchema, {
      ...value,
      computers: value.computers.map(computerCandidate),
    }),
  );
}
