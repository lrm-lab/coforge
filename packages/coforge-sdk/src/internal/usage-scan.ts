import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
  UsageScanRequestSchema,
  UsageScanResponseSchema,
} from "#src/internal/gen/coforge/rpc/v1/local_rpc_pb";

/** The local `usage:scan` exchange: the daemon asks which usage a provider's account shows. */
export type UsageScanRequest = { protocolMajor: number; requestId: string; provider: string };
export type UsageScanResponse = {
  protocolMajor: number;
  requestId: string;
  accepted: boolean;
  status: string;
  message?: string;
  snapshotJson?: Uint8Array;
};
export const encodeUsageScanRequest = (v: UsageScanRequest) =>
  toBinary(UsageScanRequestSchema, create(UsageScanRequestSchema, v));
export const decodeUsageScanRequest = (b: Uint8Array): UsageScanRequest => {
  const v = fromBinary(UsageScanRequestSchema, b);
  return { protocolMajor: v.protocolMajor, requestId: v.requestId, provider: v.provider };
};
export const encodeUsageScanResponse = (v: UsageScanResponse) =>
  toBinary(UsageScanResponseSchema, create(UsageScanResponseSchema, v));
export const decodeUsageScanResponse = (b: Uint8Array): UsageScanResponse => {
  const v = fromBinary(UsageScanResponseSchema, b);
  return {
    protocolMajor: v.protocolMajor,
    requestId: v.requestId,
    accepted: v.accepted,
    status: v.status,
    message: v.message || undefined,
    snapshotJson: v.snapshotJson.length ? v.snapshotJson : undefined,
  };
};
