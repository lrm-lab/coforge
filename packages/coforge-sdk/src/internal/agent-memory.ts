import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
  AgentMemoryRequestSchema,
  AgentMemoryResultSchema,
} from "#src/internal/gen/coforge/rpc/v1/agent_memory_pb";
import {
  decodeLocalMemoryCommand,
  decodeLocalMemoryResult,
  type LocalMemoryCommand,
  type LocalMemoryResult,
} from "#src/agent/local-memory";
import { RPC_METHODS } from "./rpc-methods";

export const AGENT_MEMORY_CAPABILITY = "agent-memory-management:v1";
export const AGENT_MEMORY_RESULT_METHOD = RPC_METHODS.daemonAgentMemoryResult;
export type AgentMemoryScope = {
  requestId: string;
  workspaceId: string;
  computerId: string;
  agentId: string;
};
export type AgentMemoryRequest = AgentMemoryScope & { command: LocalMemoryCommand };
export type AgentMemoryResult = AgentMemoryScope &
  (
    | { status: "ok"; result: LocalMemoryResult }
    | { status: "failed"; error: "not_found" | "conflict" | "invalid" | "unavailable" }
  );
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const REQUEST_TYPE = "coforge.rpc.v1.AgentMemoryRequest";
const RESULT_TYPE = "coforge.rpc.v1.AgentMemoryResult";
const MAX_BYTES = 96 * 1024;
function scope<T extends AgentMemoryScope>(value: T): T {
  if (
    ![value.requestId, value.workspaceId, value.computerId, value.agentId].every((id) =>
      UUID.test(id),
    )
  )
    throw new Error("invalid_agent_memory_scope");
  return value;
}
function parse(text: string): unknown {
  if (new TextEncoder().encode(text).byteLength > MAX_BYTES)
    throw new Error("agent_memory_too_large");
  return JSON.parse(text);
}
export function encodeAgentMemoryRequest(request: AgentMemoryRequest): Uint8Array {
  scope(request);
  const commandJson = JSON.stringify(decodeLocalMemoryCommand(request.command));
  parse(commandJson);
  return toBinary(
    AgentMemoryRequestSchema,
    create(AgentMemoryRequestSchema, {
      ...request,
      protocolMajor: 1,
      messageType: REQUEST_TYPE,
      commandJson,
    }),
  );
}
export function decodeAgentMemoryRequest(bytes: Uint8Array): AgentMemoryRequest {
  if (bytes.byteLength > MAX_BYTES + 1024) throw new Error("agent_memory_too_large");
  const value = fromBinary(AgentMemoryRequestSchema, bytes);
  if (value.protocolMajor !== 1 || value.messageType !== REQUEST_TYPE)
    throw new Error("invalid_agent_memory_request");
  return { ...scope(value), command: decodeLocalMemoryCommand(parse(value.commandJson)) };
}
export function encodeAgentMemoryResult(result: AgentMemoryResult): Uint8Array {
  scope(result);
  const resultJson =
    result.status === "ok" ? JSON.stringify(decodeLocalMemoryResult(result.result)) : "";
  if (resultJson) parse(resultJson);
  return toBinary(
    AgentMemoryResultSchema,
    create(AgentMemoryResultSchema, {
      ...result,
      protocolMajor: 1,
      messageType: RESULT_TYPE,
      resultJson,
      error: result.status === "failed" ? result.error : "",
    }),
  );
}
export function decodeAgentMemoryResult(bytes: Uint8Array): AgentMemoryResult {
  if (bytes.byteLength > MAX_BYTES + 1024) throw new Error("agent_memory_too_large");
  const value = fromBinary(AgentMemoryResultSchema, bytes);
  if (value.protocolMajor !== 1 || value.messageType !== RESULT_TYPE)
    throw new Error("invalid_agent_memory_result");
  const base = scope({
    requestId: value.requestId,
    workspaceId: value.workspaceId,
    computerId: value.computerId,
    agentId: value.agentId,
  });
  if (value.status === "ok" && !value.error)
    return { ...base, status: "ok", result: decodeLocalMemoryResult(parse(value.resultJson)) };
  if (
    value.status === "failed" &&
    !value.resultJson &&
    ["not_found", "conflict", "invalid", "unavailable"].includes(value.error)
  )
    return {
      ...base,
      status: "failed",
      error: value.error as Extract<AgentMemoryResult, { status: "failed" }>["error"],
    };
  throw new Error("invalid_agent_memory_result");
}
export function sameAgentMemoryScope(request: AgentMemoryScope, result: AgentMemoryScope): boolean {
  return (
    request.requestId === result.requestId &&
    request.workspaceId === result.workspaceId &&
    request.computerId === result.computerId &&
    request.agentId === result.agentId
  );
}
