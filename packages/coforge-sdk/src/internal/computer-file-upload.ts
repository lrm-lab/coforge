import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
  ComputerFilePullRequestSchema,
  ComputerFilePullResultSchema,
} from "#src/internal/gen/coforge/rpc/v1/computer_file_upload_pb";
import { COMPUTER_FILE_MAX_BYTES } from "./attachment-limits";
import { RPC_METHODS } from "./rpc-methods";

export { COMPUTER_FILE_MAX_BYTES };

export const COMPUTER_FILE_UPLOAD_CAPABILITY = "computer-file-upload:v1" as const;
export const COMPUTER_FILE_PULL_METHOD = RPC_METHODS.daemonComputerFilePull;
export const COMPUTER_FILE_PULL_RESULT_METHOD = RPC_METHODS.daemonComputerFilePullResult;
export const COMPUTER_FILE_SESSION_SECONDS = 900;

const REQUEST_TYPE = "coforge.rpc.v1.ComputerFilePullRequest";
const RESULT_TYPE = "coforge.rpc.v1.ComputerFilePullResult";
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const STATUSES = new Set(["ok", "error", "too_large", "unavailable"]);
const MIME = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}$/;

export type ComputerFilePullStatus = "ok" | "error" | "too_large" | "unavailable";

export type ComputerFilePullRequest = {
  protocolMajor: number;
  requestId: string;
  workspaceId: string;
  computerId: string;
  downloadUrl: string;
  fileName: string;
  sizeBytes: number;
  contentType: string;
};

export type ComputerFilePullResult = ComputerFilePullRequest & {
  status: ComputerFilePullStatus;
  path: string;
  errorMessage: string;
};

function scope(
  value: Pick<
    ComputerFilePullRequest,
    "protocolMajor" | "requestId" | "workspaceId" | "computerId"
  >,
) {
  if (
    value.protocolMajor !== 1 ||
    !ID.test(value.requestId) ||
    !ID.test(value.workspaceId) ||
    !ID.test(value.computerId)
  )
    throw new Error("Invalid computer file pull scope");
}

/** Basename-only file names safe to land under uploads/; rejects path segments. */
export function sanitizeComputerFileName(fileName: string): string {
  const base = fileName.replaceAll("\\", "/").split("/").pop()?.trim() ?? "";
  const cleaned = base
    .replace(/[^\w.\- ()[\]]+/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 200);
  if (!cleaned || cleaned === "." || cleaned === "..")
    throw new Error("Invalid computer file name");
  return cleaned;
}

function request(value: ComputerFilePullRequest): void {
  scope(value);
  if (
    value.downloadUrl.length === 0 ||
    value.downloadUrl.length > 8192 ||
    !/^https:\/\//i.test(value.downloadUrl)
  )
    throw new Error("Invalid computer file download URL");
  sanitizeComputerFileName(value.fileName);
  if (
    !Number.isSafeInteger(value.sizeBytes) ||
    value.sizeBytes <= 0 ||
    value.sizeBytes > COMPUTER_FILE_MAX_BYTES
  )
    throw new Error("Invalid computer file size");
  if (!MIME.test(value.contentType) || value.contentType.length > 200)
    throw new Error("Invalid computer file content type");
}

function result(value: ComputerFilePullResult): void {
  request(value);
  if (!STATUSES.has(value.status)) throw new Error("Invalid computer file pull status");
  if (value.path.length > 4096 || value.path.includes("\0"))
    throw new Error("Invalid computer file path");
  if (value.errorMessage.length > 1000 || value.errorMessage.includes("\0"))
    throw new Error("Invalid computer file error message");
  if (value.status === "ok" && value.path.length === 0)
    throw new Error("Computer file pull ok requires a path");
}

export function encodeComputerFilePullRequest(value: ComputerFilePullRequest): Uint8Array {
  request(value);
  return toBinary(
    ComputerFilePullRequestSchema,
    create(ComputerFilePullRequestSchema, {
      ...value,
      sizeBytes: BigInt(value.sizeBytes),
      messageType: REQUEST_TYPE,
    }),
  );
}

export function decodeComputerFilePullRequest(bytes: Uint8Array): ComputerFilePullRequest {
  const value = fromBinary(ComputerFilePullRequestSchema, bytes);
  if (value.messageType !== REQUEST_TYPE) throw new Error("Invalid computer file pull request");
  const decoded: ComputerFilePullRequest = {
    protocolMajor: value.protocolMajor,
    requestId: value.requestId,
    workspaceId: value.workspaceId,
    computerId: value.computerId,
    downloadUrl: value.downloadUrl,
    fileName: value.fileName,
    sizeBytes: Number(value.sizeBytes),
    contentType: value.contentType,
  };
  request(decoded);
  return decoded;
}

export function encodeComputerFilePullResult(value: ComputerFilePullResult): Uint8Array {
  result(value);
  return toBinary(
    ComputerFilePullResultSchema,
    create(ComputerFilePullResultSchema, {
      ...value,
      sizeBytes: BigInt(value.sizeBytes),
      messageType: RESULT_TYPE,
    }),
  );
}

export function decodeComputerFilePullResult(bytes: Uint8Array): ComputerFilePullResult {
  const value = fromBinary(ComputerFilePullResultSchema, bytes);
  if (value.messageType !== RESULT_TYPE) throw new Error("Invalid computer file pull result");
  const decoded: ComputerFilePullResult = {
    protocolMajor: value.protocolMajor,
    requestId: value.requestId,
    workspaceId: value.workspaceId,
    computerId: value.computerId,
    downloadUrl: value.downloadUrl,
    fileName: value.fileName,
    sizeBytes: Number(value.sizeBytes),
    contentType: value.contentType,
    status: value.status as ComputerFilePullStatus,
    path: value.path,
    errorMessage: value.errorMessage,
  };
  result(decoded);
  return decoded;
}
