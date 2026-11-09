import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { AgentConfigSyncSchema } from "#src/internal/gen/coforge/rpc/v1/agent_config_pb";
import type { RuntimeProvider } from "./runtime-provider";
import type { AgentRuntimeProviderConfig } from "./index";

export const AGENT_CONFIG_SYNC_MESSAGE_TYPE = "coforge.rpc.v1.AgentConfigSync" as const;
export const AGENT_CONFIG_SYNC_PROTOCOL_MAJOR = 1 as const;
export const AGENT_CONFIG_CAPABILITY = "agent-config:v1" as const;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

export type AgentConfigSync = {
  protocolMajor: 1;
  workspaceId: string;
  computerId: string;
  agentId: string;
  revision: number;
  provider: RuntimeProvider;
  model: string;
  modelProvider?: string;
  reasoning: string;
  fastMode?: boolean;
  providerConfig?: AgentRuntimeProviderConfig;
};

function validate(value: AgentConfigSync): void {
  if (
    value.protocolMajor !== AGENT_CONFIG_SYNC_PROTOCOL_MAJOR ||
    !ID.test(value.workspaceId) ||
    !ID.test(value.computerId) ||
    !ID.test(value.agentId) ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 1 ||
    !value.provider ||
    value.model.length > 512 ||
    (value.modelProvider !== undefined && value.modelProvider.length > 512) ||
    value.reasoning.length > 512 ||
    (value.providerConfig !== undefined &&
      ((value.providerConfig.kind !== "default" && value.providerConfig.kind !== "coforge") ||
        (value.providerConfig.kind === "coforge" &&
          (!value.providerConfig.providerId || value.providerConfig.providerId.length > 512))))
  )
    throw new Error("Invalid Agent config sync");
}

export function encodeAgentConfigSync(value: AgentConfigSync): Uint8Array {
  validate(value);
  return toBinary(
    AgentConfigSyncSchema,
    create(AgentConfigSyncSchema, {
      messageType: AGENT_CONFIG_SYNC_MESSAGE_TYPE,
      protocolMajor: value.protocolMajor,
      workspaceId: value.workspaceId,
      computerId: value.computerId,
      agentId: value.agentId,
      revision: BigInt(value.revision),
      provider: value.provider,
      model: value.model,
      modelProvider: value.modelProvider,
      reasoning: value.reasoning,
      fastMode: value.fastMode,
      providerKind: value.providerConfig?.kind,
      providerId:
        value.providerConfig?.kind === "coforge" ? value.providerConfig.providerId : undefined,
    }),
  );
}

export function decodeAgentConfigSync(bytes: Uint8Array): AgentConfigSync {
  const value = fromBinary(AgentConfigSyncSchema, bytes);
  const providerConfig = value.providerKind
    ? value.providerKind === "coforge" && value.providerId
      ? { kind: "coforge" as const, providerId: value.providerId }
      : value.providerKind === "default"
        ? { kind: "default" as const }
        : undefined
    : undefined;
  const result = {
    protocolMajor: value.protocolMajor as 1,
    workspaceId: value.workspaceId,
    computerId: value.computerId,
    agentId: value.agentId,
    revision: Number(value.revision),
    provider: value.provider as RuntimeProvider,
    model: value.model,
    ...(value.modelProvider ? { modelProvider: value.modelProvider } : {}),
    reasoning: value.reasoning,
    ...(value.fastMode !== undefined ? { fastMode: value.fastMode } : {}),
    ...(providerConfig ? { providerConfig } : {}),
  } satisfies AgentConfigSync;
  if (value.messageType !== AGENT_CONFIG_SYNC_MESSAGE_TYPE)
    throw new Error("Invalid Agent config sync message");
  validate(result);
  return result;
}
