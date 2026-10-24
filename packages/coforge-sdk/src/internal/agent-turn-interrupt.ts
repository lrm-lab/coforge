import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
  AgentTurnInterruptIntentSchema,
  AgentTurnInterruptResultSchema,
} from "#src/internal/gen/coforge/rpc/v1/agent_control_pb";
import { boundedPayload } from "./codec";
import { isScopeId } from "./scope-id";
import { requireRuntimeProvider, type RuntimeProvider } from "./index";
import { RPC_METHODS } from "./rpc-methods";

export const AGENT_TURN_INTERRUPT_METHOD = RPC_METHODS.agentTurnInterrupt;
export const AGENT_TURN_INTERRUPT_RESULT_METHOD = RPC_METHODS.agentTurnInterruptResult;
export const AGENT_TURN_INTERRUPT_CAPABILITY = "agent-turn-interrupt:v1" as const;

const INTENT_TYPE = "coforge.rpc.v1.AgentTurnInterruptIntent";
const RESULT_TYPE = "coforge.rpc.v1.AgentTurnInterruptResult";
const MAX_BYTES = 32_768;
const MAX_COUNTER = 2 ** 31 - 1;
const MAX_TOOL_NAME = 200;

export type AgentTurnInterruptScope = {
  protocolMajor: number;
  requestId: string;
  workspaceId: string;
  computerId: string;
  agentId: string;
  provider: RuntimeProvider;
  epoch: number;
  launchId: string;
};

export type AgentTurnInterruptIntent = AgentTurnInterruptScope;

export type AgentTurnInterruptStatus = "interrupted" | "restarted" | "not_running";

export type AgentTurnInterruptResult = AgentTurnInterruptScope & {
  status: AgentTurnInterruptStatus;
  toolName?: string;
  silentForMs?: number;
};

function bounded(bytes: Uint8Array): Uint8Array {
  return boundedPayload(bytes, MAX_BYTES, "Agent turn interrupt");
}

function scope(value: AgentTurnInterruptScope): AgentTurnInterruptScope {
  if (
    value.protocolMajor !== 1 ||
    !Number.isSafeInteger(value.epoch) ||
    value.epoch < 1 ||
    value.epoch > MAX_COUNTER ||
    [value.requestId, value.workspaceId, value.computerId, value.agentId, value.launchId].some(
      (id) => !isScopeId(id),
    )
  )
    throw new Error("invalid agent turn interrupt scope");
  return { ...value };
}

function status(value: string): AgentTurnInterruptStatus {
  if (!["interrupted", "restarted", "not_running"].includes(value))
    throw new Error("invalid agent turn interrupt status");
  return value as AgentTurnInterruptStatus;
}

function optionalToolName(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!value || value.length > MAX_TOOL_NAME || value.includes("\n") || value.includes("\r"))
    throw new Error("invalid agent turn interrupt tool name");
  return value;
}

function optionalSilentForMs(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 0 || value > Number.MAX_SAFE_INTEGER)
    throw new Error("invalid agent turn interrupt silent duration");
  return value;
}

export function encodeAgentTurnInterruptIntent(value: AgentTurnInterruptIntent): Uint8Array {
  const checked = scope(value);
  return bounded(
    toBinary(
      AgentTurnInterruptIntentSchema,
      create(AgentTurnInterruptIntentSchema, { ...checked, messageType: INTENT_TYPE }),
    ),
  );
}

export function decodeAgentTurnInterruptIntent(bytes: Uint8Array): AgentTurnInterruptIntent {
  const value = fromBinary(AgentTurnInterruptIntentSchema, bounded(bytes));
  if (value.messageType !== INTENT_TYPE) throw new Error("invalid agent turn interrupt intent");
  const { $typeName: _, messageType: __, ...fields } = value;
  return scope({
    ...fields,
    provider: requireRuntimeProvider(value.provider, "invalid provider"),
  });
}

export function encodeAgentTurnInterruptResult(value: AgentTurnInterruptResult): Uint8Array {
  const checked = {
    ...scope(value),
    status: status(value.status),
    toolName: optionalToolName(value.toolName),
    silentForMs: optionalSilentForMs(value.silentForMs),
  };
  const wire = {
    protocolMajor: checked.protocolMajor,
    requestId: checked.requestId,
    workspaceId: checked.workspaceId,
    computerId: checked.computerId,
    agentId: checked.agentId,
    provider: checked.provider,
    epoch: checked.epoch,
    launchId: checked.launchId,
    status: checked.status,
    ...(checked.toolName !== undefined ? { toolName: checked.toolName } : {}),
    ...(checked.silentForMs !== undefined ? { silentForMs: BigInt(checked.silentForMs) } : {}),
    messageType: RESULT_TYPE,
  };
  return bounded(
    toBinary(AgentTurnInterruptResultSchema, create(AgentTurnInterruptResultSchema, wire)),
  );
}

export function decodeAgentTurnInterruptResult(bytes: Uint8Array): AgentTurnInterruptResult {
  const value = fromBinary(AgentTurnInterruptResultSchema, bounded(bytes));
  if (value.messageType !== RESULT_TYPE) throw new Error("invalid agent turn interrupt result");
  const { $typeName: _, messageType: __, ...fields } = value;
  return {
    ...scope({
      ...fields,
      provider: requireRuntimeProvider(value.provider, "invalid provider"),
    }),
    status: status(value.status),
    ...(value.toolName !== undefined ? { toolName: optionalToolName(value.toolName) } : {}),
    ...(value.silentForMs !== undefined
      ? { silentForMs: optionalSilentForMs(Number(value.silentForMs)) }
      : {}),
  };
}
