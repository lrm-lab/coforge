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
export const decodeUsageScanRequest = (b: Uint8Array): UsageScanRequest => {
  const v = fromBinary(UsageScanRequestSchema, b);
  return { protocolMajor: v.protocolMajor, requestId: v.requestId, provider: v.provider };
};
export const encodeUsageScanResponse = (v: UsageScanResponse) =>
  toBinary(UsageScanResponseSchema, create(UsageScanResponseSchema, v));
