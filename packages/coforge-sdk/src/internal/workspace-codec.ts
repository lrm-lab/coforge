import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
  WorkspaceGetRequestSchema,
  WorkspaceGetResponseSchema,
  WorkspaceListRequestSchema,
  WorkspaceListResponseSchema,
} from "#src/internal/gen/coforge/rpc/v1/workspace_pb";
import {
  ComputerRegisterRequestSchema,
  ComputerRegisterResponseSchema,
} from "#src/internal/gen/coforge/rpc/v1/computer_pb";
import type {
  ComputerRegisterRequest,
  ComputerRegisterResponse,
  Workspace,
  WorkspaceQueryRequest,
} from "./index";

const workspaceRequest = (value: WorkspaceQueryRequest) => ({
  protocolMajor: value.protocolMajor,
  requestId: value.requestId,
  workspaceSlug: value.workspaceSlug ?? "",
});

export function encodeWorkspaceListRequest(value: WorkspaceQueryRequest) {
  return toBinary(
    WorkspaceListRequestSchema,
    create(WorkspaceListRequestSchema, workspaceRequest(value)),
  );
}
export function encodeWorkspaceGetRequest(value: WorkspaceQueryRequest) {
  return toBinary(
    WorkspaceGetRequestSchema,
    create(WorkspaceGetRequestSchema, workspaceRequest(value)),
  );
}
export function decodeWorkspaceListRequest(bytes: Uint8Array) {
  const v = fromBinary(WorkspaceListRequestSchema, bytes);
  return v;
}
export function decodeWorkspaceGetRequest(bytes: Uint8Array) {
  const v = fromBinary(WorkspaceGetRequestSchema, bytes);
  return v;
}
export function decodeWorkspaceListResponse(bytes: Uint8Array) {
  const v = fromBinary(WorkspaceListResponseSchema, bytes);
  return {
    protocolMajor: v.protocolMajor,
    requestId: v.requestId,
    workspaces: v.workspaces.map(workspace),
  };
}
export function decodeWorkspaceGetResponse(bytes: Uint8Array) {
  const v = fromBinary(WorkspaceGetResponseSchema, bytes);
  if (!v.workspace) throw new Error("workspace not found");
  return {
    protocolMajor: v.protocolMajor,
    requestId: v.requestId,
    workspace: workspace(v.workspace),
  };
}
const workspace = (v: { id: string; slug: string; name: string }): Workspace => ({
  id: v.id,
  slug: v.slug,
  name: v.name,
});
export function encodeWorkspaceListResponse(value: {
  protocolMajor: number;
  requestId: string;
  workspaces: Workspace[];
}) {
  return toBinary(WorkspaceListResponseSchema, create(WorkspaceListResponseSchema, value));
}
export function encodeWorkspaceGetResponse(value: {
  protocolMajor: number;
  requestId: string;
  workspace: Workspace;
}) {
  return toBinary(WorkspaceGetResponseSchema, create(WorkspaceGetResponseSchema, value));
}

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
