import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
  AgentWorkspaceScanEntrySchema,
  AgentWorkspaceScanRequestSchema,
  AgentWorkspaceScanResultSchema,
} from "#src/internal/gen/coforge/rpc/v1/agent_workspace_files_pb";
import { RPC_METHODS } from "./rpc-methods";

export const AGENT_WORKSPACE_SCAN_METHOD = RPC_METHODS.agentWorkspaceScan;
export const AGENT_WORKSPACE_SCAN_RESULT_METHOD = RPC_METHODS.agentWorkspaceScanResult;

const REQUEST_TYPE = "coforge.rpc.v1.AgentWorkspaceScanRequest";
const RESULT_TYPE = "coforge.rpc.v1.AgentWorkspaceScanResult";
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export type AgentWorkspaceScanRequest = {
  protocolMajor: number;
  requestId: string;
  workspaceId: string;
  computerId: string;
};
export type AgentWorkspaceScanEntry = {
  agentId: string;
  status: "present";
  rootPath: string;
  modifiedAtMs: number;
};
export type AgentWorkspaceScanResult = AgentWorkspaceScanRequest & {
  workspaces: AgentWorkspaceScanEntry[];
};

function ids(value: AgentWorkspaceScanRequest) {
  if (
    !value.requestId ||
    !ID.test(value.requestId) ||
    !ID.test(value.workspaceId) ||
    !ID.test(value.computerId)
  )
    throw new Error("Invalid Agent workspace scan scope");
}

export function encodeAgentWorkspaceScanRequest(value: AgentWorkspaceScanRequest): Uint8Array {
  ids(value);
  return toBinary(
    AgentWorkspaceScanRequestSchema,
    create(AgentWorkspaceScanRequestSchema, {
      protocolMajor: value.protocolMajor,
      requestId: value.requestId,
      workspaceId: value.workspaceId,
      computerId: value.computerId,
      messageType: REQUEST_TYPE,
    }),
  );
}

export function decodeAgentWorkspaceScanRequest(bytes: Uint8Array): AgentWorkspaceScanRequest {
  const value = fromBinary(AgentWorkspaceScanRequestSchema, bytes);
  const result = {
    protocolMajor: value.protocolMajor,
    requestId: value.requestId,
    workspaceId: value.workspaceId,
    computerId: value.computerId,
  };
  ids(result);
  if (value.messageType !== REQUEST_TYPE) throw new Error("Invalid Agent workspace scan request");
  return result;
}

export function encodeAgentWorkspaceScanResult(value: AgentWorkspaceScanResult): Uint8Array {
  ids(value);
  if (value.workspaces.some((workspace) => !ID.test(workspace.agentId)))
    throw new Error("Invalid Agent workspace scan entry");
  return toBinary(
    AgentWorkspaceScanResultSchema,
    create(AgentWorkspaceScanResultSchema, {
      protocolMajor: value.protocolMajor,
      requestId: value.requestId,
      workspaceId: value.workspaceId,
      computerId: value.computerId,
      messageType: RESULT_TYPE,
      workspaces: value.workspaces.map((workspace) =>
        create(AgentWorkspaceScanEntrySchema, {
          agentId: workspace.agentId,
          status: workspace.status,
          rootPath: workspace.rootPath,
          modifiedAtMs: BigInt(workspace.modifiedAtMs),
        }),
      ),
    }),
  );
}

export function decodeAgentWorkspaceScanResult(bytes: Uint8Array): AgentWorkspaceScanResult {
  const value = fromBinary(AgentWorkspaceScanResultSchema, bytes);
  const result: AgentWorkspaceScanResult = {
    protocolMajor: value.protocolMajor,
    requestId: value.requestId,
    workspaceId: value.workspaceId,
    computerId: value.computerId,
    workspaces: value.workspaces.map((workspace) => ({
      agentId: workspace.agentId,
      status: workspace.status as AgentWorkspaceScanEntry["status"],
      rootPath: workspace.rootPath,
      modifiedAtMs: Number(workspace.modifiedAtMs),
    })),
  };
  ids(result);
  if (value.messageType !== RESULT_TYPE) throw new Error("Invalid Agent workspace scan result");
  if (result.workspaces.some((workspace) => !ID.test(workspace.agentId)))
    throw new Error("Invalid Agent workspace scan entry");
  return result;
}
