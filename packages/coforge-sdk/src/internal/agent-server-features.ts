import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { AgentServerFeaturesSchema } from "#src/internal/gen/coforge/rpc/v1/agent_server_features_pb";

export const AGENT_SERVER_FEATURES_MESSAGE_TYPE = "coforge.rpc.v1.AgentServerFeatures" as const;
export const AGENT_SERVER_FEATURES_PROTOCOL_MAJOR = 1 as const;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

export type AgentServerFeatures = {
  protocolMajor: 1;
  requestId: string;
  workspaceId: string;
  computerId: string;
  revision: number;
  agentIds: string[];
  agentContextView?: boolean;
};

function validate(value: AgentServerFeatures): void {
  if (
    value.protocolMajor !== AGENT_SERVER_FEATURES_PROTOCOL_MAJOR ||
    !ID.test(value.workspaceId) ||
    !ID.test(value.computerId) ||
    !value.requestId ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 1 ||
    value.agentIds.some((id) => !ID.test(id))
  )
    throw new Error("Invalid agent server features scope");
}

export function encodeAgentServerFeatures(value: AgentServerFeatures): Uint8Array {
  validate(value);
  return toBinary(
    AgentServerFeaturesSchema,
    create(AgentServerFeaturesSchema, {
      ...value,
      messageType: AGENT_SERVER_FEATURES_MESSAGE_TYPE,
      revision: BigInt(value.revision),
    }),
  );
}

export function decodeAgentServerFeatures(bytes: Uint8Array): AgentServerFeatures {
  const value = fromBinary(AgentServerFeaturesSchema, bytes);
  if (value.messageType !== AGENT_SERVER_FEATURES_MESSAGE_TYPE)
    throw new Error("Invalid agent server features message");
  const result: AgentServerFeatures = {
    protocolMajor: value.protocolMajor as 1,
    requestId: value.requestId,
    workspaceId: value.workspaceId,
    computerId: value.computerId,
    revision: Number(value.revision),
    agentIds: [...value.agentIds],
    agentContextView: value.agentContextView,
  };
  validate(result);
  return result;
}
