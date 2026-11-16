import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { AgentStaleRuntimeStopSchema } from "#src/internal/gen/coforge/rpc/v1/workspace_pb";
import { assertPositiveControlCounter } from "./codec";
import { RPC_METHODS } from "./rpc-methods";

export const AGENT_STALE_RUNTIME_STOP_METHOD = RPC_METHODS.agentStaleRuntimeStop;
export const AGENT_STALE_RUNTIME_STOP_MESSAGE_TYPE =
  "coforge.rpc.v1.AgentStaleRuntimeStop" as const;

export type AgentStaleRuntimeStop = {
  protocolMajor: number;
  requestId: string;
  workspaceId: string;
  agentId: string;
  computerId: string;
  controlEpoch: number;
};

function valid(value: AgentStaleRuntimeStop): AgentStaleRuntimeStop {
  if (
    value.protocolMajor !== 1 ||
    !value.requestId ||
    !value.workspaceId ||
    !value.agentId ||
    !value.computerId
  )
    throw new Error("invalid stale runtime stop");
  assertPositiveControlCounter(value.controlEpoch, "control epoch");
  return value;
}

export function encodeAgentStaleRuntimeStop(value: AgentStaleRuntimeStop): Uint8Array {
  const checked = valid(value);
  return toBinary(
    AgentStaleRuntimeStopSchema,
    create(AgentStaleRuntimeStopSchema, {
      protocolMajor: checked.protocolMajor,
      requestId: checked.requestId,
      workspaceId: checked.workspaceId,
      agentId: checked.agentId,
      computerId: checked.computerId,
      controlEpoch: checked.controlEpoch,
    }),
  );
}

export function decodeAgentStaleRuntimeStop(bytes: Uint8Array): AgentStaleRuntimeStop {
  const value = fromBinary(AgentStaleRuntimeStopSchema, bytes);
  return valid({
    protocolMajor: value.protocolMajor,
    requestId: value.requestId,
    workspaceId: value.workspaceId,
    agentId: value.agentId,
    computerId: value.computerId,
    controlEpoch: value.controlEpoch,
  });
}
