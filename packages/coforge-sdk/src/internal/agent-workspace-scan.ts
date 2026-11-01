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

export type AgentWorkspaceStatisticsStatus = "complete" | "truncated" | "skipped";

export type AgentWorkspaceScanRequest = {
  protocolMajor: number;
  requestId: string;
  workspaceId: string;
  computerId: string;
  /** False lists the directories alone; true also measures each one under the Daemon's budgets. */
  withStatistics: boolean;
};
export type AgentWorkspaceScanEntry = {
  agentId: string;
  status: "present";
  rootPath: string;
  modifiedAtMs: number;
  /** Lower bounds when `statisticsStatus` is "truncated"; 0 in a listing-only scan. */
  fileCount: number;
  totalSizeBytes: number;
  /** Empty in a listing-only scan; the outcome of the budgeted walk otherwise. */
  statisticsStatus: AgentWorkspaceStatisticsStatus | "";
};
export type AgentWorkspaceScanResult = AgentWorkspaceScanRequest & {
  workspaces: AgentWorkspaceScanEntry[];
};

const STATISTICS_STATUSES = new Set<string>(["", "complete", "truncated", "skipped"]);

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
      withStatistics: value.withStatistics,
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
    withStatistics: value.withStatistics,
  };
  ids(result);
  if (value.messageType !== REQUEST_TYPE) throw new Error("Invalid Agent workspace scan request");
  return result;
}

export function encodeAgentWorkspaceScanResult(value: AgentWorkspaceScanResult): Uint8Array {
  ids(value);
  if (value.workspaces.some((workspace) => !ID.test(workspace.agentId)))
    throw new Error("Invalid Agent workspace scan entry");
  if (value.workspaces.some((workspace) => !STATISTICS_STATUSES.has(workspace.statisticsStatus)))
    throw new Error("Invalid Agent workspace statistics status");
  return toBinary(
    AgentWorkspaceScanResultSchema,
    create(AgentWorkspaceScanResultSchema, {
      protocolMajor: value.protocolMajor,
      requestId: value.requestId,
      workspaceId: value.workspaceId,
      computerId: value.computerId,
      withStatistics: value.withStatistics,
      messageType: RESULT_TYPE,
      workspaces: value.workspaces.map((workspace) =>
        create(AgentWorkspaceScanEntrySchema, {
          agentId: workspace.agentId,
          status: workspace.status,
          rootPath: workspace.rootPath,
          modifiedAtMs: BigInt(workspace.modifiedAtMs),
          fileCount: BigInt(workspace.fileCount),
          totalSizeBytes: BigInt(workspace.totalSizeBytes),
          statisticsStatus: workspace.statisticsStatus,
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
    withStatistics: value.withStatistics,
    workspaces: value.workspaces.map((workspace) => ({
      agentId: workspace.agentId,
      status: workspace.status as AgentWorkspaceScanEntry["status"],
      rootPath: workspace.rootPath,
      modifiedAtMs: Number(workspace.modifiedAtMs),
      fileCount: Number(workspace.fileCount),
      totalSizeBytes: Number(workspace.totalSizeBytes),
      statisticsStatus: workspace.statisticsStatus as AgentWorkspaceScanEntry["statisticsStatus"],
    })),
  };
  ids(result);
  if (value.messageType !== RESULT_TYPE) throw new Error("Invalid Agent workspace scan result");
  if (result.workspaces.some((workspace) => !ID.test(workspace.agentId)))
    throw new Error("Invalid Agent workspace scan entry");
  if (result.workspaces.some((workspace) => !STATISTICS_STATUSES.has(workspace.statisticsStatus)))
    throw new Error("Invalid Agent workspace statistics status");
  return result;
}
