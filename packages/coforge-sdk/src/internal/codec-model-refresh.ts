import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
  DaemonRuntimeProviderModelRefreshRequestSchema,
  DaemonRuntimeProviderModelRefreshResponseSchema,
} from "#src/internal/gen/coforge/rpc/v1/daemon_runtime_pb";
import {
  MODEL_REFRESH_MESSAGE_TYPE,
  MODEL_REFRESH_RESPONSE_MESSAGE_TYPE,
  parseRuntimeUnavailableCode,
  requireRuntimeProvider,
} from "./index";
import { decodedModelCatalog, modelCatalog } from "./codec-runtime-inventory";

export const encodeDaemonRuntimeProviderModelRefreshRequest = (
  v: import("./index").DaemonRuntimeProviderModelRefreshRequest,
) =>
  toBinary(
    DaemonRuntimeProviderModelRefreshRequestSchema,
    create(DaemonRuntimeProviderModelRefreshRequestSchema, {
      ...v,
      messageType: MODEL_REFRESH_MESSAGE_TYPE,
    }),
  );
export function decodeDaemonRuntimeProviderModelRefreshRequest(bytes: Uint8Array) {
  const v = fromBinary(DaemonRuntimeProviderModelRefreshRequestSchema, bytes);
  if (v.messageType !== MODEL_REFRESH_MESSAGE_TYPE)
    throw new Error("invalid daemon runtime message type");
  return {
    protocolMajor: v.protocolMajor,
    requestId: v.requestId,
    workspaceId: v.workspaceId,
    computerId: v.computerId,
    ...(v.provider
      ? {
          provider: requireRuntimeProvider(
            v.provider,
            `unsupported runtime provider: ${v.provider}`,
          ),
        }
      : {}),
    messageType: v.messageType,
  };
}
export const encodeDaemonRuntimeProviderModelRefreshResponse = (
  v: import("./index").DaemonRuntimeProviderModelRefreshResponse,
) =>
  toBinary(
    DaemonRuntimeProviderModelRefreshResponseSchema,
    create(DaemonRuntimeProviderModelRefreshResponseSchema, {
      ...v,
      results: v.results.map((result) => ({
        provider: result.provider,
        status: result.status,
        code: result.code ?? "",
        diagnostic: result.diagnostic ?? "",
        ...(result.catalog ? { catalog: modelCatalog(result.catalog) } : {}),
      })),
      messageType: MODEL_REFRESH_RESPONSE_MESSAGE_TYPE,
    }),
  );
export function decodeDaemonRuntimeProviderModelRefreshResponse(
  bytes: Uint8Array,
): import("./index").DaemonRuntimeProviderModelRefreshResponse {
  const v = fromBinary(DaemonRuntimeProviderModelRefreshResponseSchema, bytes);
  if (v.messageType !== MODEL_REFRESH_RESPONSE_MESSAGE_TYPE)
    throw new Error("invalid daemon runtime message type");
  return {
    protocolMajor: v.protocolMajor,
    requestId: v.requestId,
    workspaceId: v.workspaceId,
    computerId: v.computerId,
    accepted: v.accepted,
    results: v.results.map((result) => {
      const code = parseRuntimeUnavailableCode(result.code);
      return {
        provider: requireRuntimeProvider(
          result.provider,
          `unsupported runtime provider: ${result.provider}`,
        ),
        status: result.status === "refreshed" ? ("refreshed" as const) : ("error" as const),
        ...(code ? { code } : {}),
        ...(result.diagnostic ? { diagnostic: result.diagnostic } : {}),
        ...(result.catalog ? { catalog: decodedModelCatalog(result.catalog) } : {}),
      };
    }),
    messageType: v.messageType,
  };
}
