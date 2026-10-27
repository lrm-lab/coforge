import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
  DaemonRuntimeCommandCodeEffortReadRequestSchema,
  DaemonRuntimeCommandCodeEffortReadResponseSchema,
} from "#src/internal/gen/coforge/rpc/v1/daemon_runtime_pb";
import {
  COMMAND_CODE_EFFORT_READ_MESSAGE_TYPE,
  COMMAND_CODE_EFFORT_READ_RESPONSE_MESSAGE_TYPE,
  type DaemonRuntimeCommandCodeEffortReadRequest,
  type DaemonRuntimeCommandCodeEffortReadResponse,
} from "./index";

export const encodeDaemonRuntimeCommandCodeEffortReadRequest = (
  value: DaemonRuntimeCommandCodeEffortReadRequest,
) =>
  toBinary(
    DaemonRuntimeCommandCodeEffortReadRequestSchema,
    create(DaemonRuntimeCommandCodeEffortReadRequestSchema, {
      ...value,
      messageType: COMMAND_CODE_EFFORT_READ_MESSAGE_TYPE,
    }),
  );

export function decodeDaemonRuntimeCommandCodeEffortReadRequest(
  bytes: Uint8Array,
): DaemonRuntimeCommandCodeEffortReadRequest {
  const value = fromBinary(DaemonRuntimeCommandCodeEffortReadRequestSchema, bytes);
  if (value.messageType !== COMMAND_CODE_EFFORT_READ_MESSAGE_TYPE)
    throw new Error("invalid daemon runtime message type");
  return {
    protocolMajor: value.protocolMajor,
    requestId: value.requestId,
    workspaceId: value.workspaceId,
    computerId: value.computerId,
    modelId: value.modelId,
    messageType: COMMAND_CODE_EFFORT_READ_MESSAGE_TYPE,
  };
}

export const encodeDaemonRuntimeCommandCodeEffortReadResponse = (
  value: DaemonRuntimeCommandCodeEffortReadResponse,
) =>
  toBinary(
    DaemonRuntimeCommandCodeEffortReadResponseSchema,
    create(DaemonRuntimeCommandCodeEffortReadResponseSchema, {
      ...value,
      efforts: value.efforts ?? [],
      messageType: COMMAND_CODE_EFFORT_READ_RESPONSE_MESSAGE_TYPE,
    }),
  );

export function decodeDaemonRuntimeCommandCodeEffortReadResponse(
  bytes: Uint8Array,
): DaemonRuntimeCommandCodeEffortReadResponse {
  const value = fromBinary(DaemonRuntimeCommandCodeEffortReadResponseSchema, bytes);
  if (value.messageType !== COMMAND_CODE_EFFORT_READ_RESPONSE_MESSAGE_TYPE)
    throw new Error("invalid daemon runtime message type");
  return {
    protocolMajor: value.protocolMajor,
    requestId: value.requestId,
    workspaceId: value.workspaceId,
    computerId: value.computerId,
    accepted: value.accepted,
    status: value.status,
    efforts: [...value.efforts],
    messageType: COMMAND_CODE_EFFORT_READ_RESPONSE_MESSAGE_TYPE,
  };
}
