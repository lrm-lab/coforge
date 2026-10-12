import { RPC_METHODS } from "./rpc-methods";
import { RPC_PAYLOAD_MAX_BYTES } from "./bounded-payload";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { decodeBase64, encodeBase64 } from "./base64";
import {
  AgentWorkspaceFilesListRequestSchema,
  AgentWorkspaceFilesListResultSchema,
  AgentWorkspaceFileReadRequestSchema,
  AgentWorkspaceFileReadResultSchema,
  AgentWorkspaceDeleteRequestSchema,
  AgentWorkspaceDeleteResultSchema,
} from "#src/internal/gen/coforge/rpc/v1/agent_workspace_files_pb";

export const AGENT_WORKSPACE_FILES_LIST_METHOD = RPC_METHODS.agentWorkspaceFilesList;
export const AGENT_WORKSPACE_FILES_LIST_RESULT_METHOD = RPC_METHODS.agentWorkspaceFilesListResult;
export const AGENT_WORKSPACE_FILE_READ_METHOD = RPC_METHODS.agentWorkspaceFileRead;
export const AGENT_WORKSPACE_FILE_READ_RESULT_METHOD = RPC_METHODS.agentWorkspaceFileReadResult;
export const AGENT_WORKSPACE_DELETE_METHOD = RPC_METHODS.agentWorkspaceDelete;
export const AGENT_WORKSPACE_DELETE_RESULT_METHOD = RPC_METHODS.agentWorkspaceDeleteResult;

const LIST_REQUEST_TYPE = "coforge.rpc.v1.AgentWorkspaceFilesListRequest";
const LIST_RESULT_TYPE = "coforge.rpc.v1.AgentWorkspaceFilesListResult";
const READ_REQUEST_TYPE = "coforge.rpc.v1.AgentWorkspaceFileReadRequest";
const READ_RESULT_TYPE = "coforge.rpc.v1.AgentWorkspaceFileReadResult";
const DELETE_REQUEST_TYPE = "coforge.rpc.v1.AgentWorkspaceDeleteRequest";
const DELETE_RESULT_TYPE = "coforge.rpc.v1.AgentWorkspaceDeleteResult";
const MAX_TEXT_BYTES = 512 * 1024;
/** The image payload one read result may carry. The whole message travels in a single Centrifugo
 * publish — the limit it has to fit is `RPC_PAYLOAD_MAX_BYTES` — so this is the bound that keeps a
 * read of a large image from overflowing that limit. */
const MAX_CONTENT_BYTES = RPC_PAYLOAD_MAX_BYTES;
/** What `encodeBase64` yields for `MAX_CONTENT_BYTES`, checked before decoding so an oversized
 * payload is refused without allocating it twice. */
const MAX_CONTENT_BASE64_LENGTH = Math.ceil(MAX_CONTENT_BYTES / 3) * 4;
/** A read result is either text or an image, never both, so its message is bounded by the larger
 * of the two payloads plus the scope fields around it. */
const MAX_READ_RESULT_BYTES = MAX_CONTENT_BYTES + MAX_TEXT_BYTES;
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export type AgentWorkspaceFilesListRequest = {
  protocolMajor: number;
  requestId: string;
  workspaceId: string;
  computerId: string;
  agentId: string;
  dirPath: string;
  includeHidden: boolean;
};
export type AgentWorkspaceFileEntry = {
  name: string;
  type: "file" | "dir" | "symlink" | "other";
  sizeBytes: number;
  modifiedAtMs: number;
};
export type AgentWorkspaceFilesListResult = AgentWorkspaceFilesListRequest & {
  status: "ok" | "missing" | "unreadable" | "error";
  rootPath: string;
  entries: AgentWorkspaceFileEntry[];
};

export type AgentWorkspaceFileReadRequest = {
  protocolMajor: number;
  requestId: string;
  workspaceId: string;
  computerId: string;
  agentId: string;
  path: string;
};
export type AgentWorkspaceFileReadResult = AgentWorkspaceFileReadRequest & {
  status: "ok" | "missing" | "unreadable" | "binary" | "too_large" | "error";
  sizeBytes: number;
  modifiedAtMs: number;
  text: string;
  /** The media type of `contentBase64` — the type the bytes really are, not what the file name
   * claims — or `""` for every read that fills `text` instead. */
  contentType: string;
  /** Standard base64 of a previewable image's bytes, or `""` for a text read. The wire carries
   * these bytes as protobuf `bytes`; base64 is the spelling every in-process consumer sees because
   * a read result also crosses a JSON boundary on its way to the browser. */
  contentBase64: string;
};
export type AgentWorkspaceDeleteRequest = {
  protocolMajor: number;
  requestId: string;
  workspaceId: string;
  computerId: string;
  agentId: string;
};
export type AgentWorkspaceDeleteResult = AgentWorkspaceDeleteRequest & {
  status: "ok" | "missing" | "unreadable" | "error";
};

function scopeIds(value: {
  requestId: string;
  workspaceId: string;
  computerId: string;
  agentId: string;
}) {
  if (
    ![value.requestId, value.workspaceId, value.computerId, value.agentId].every((id) =>
      ID.test(id),
    )
  )
    throw new Error("Invalid Workspace Files request scope");
}
function relativePath(value: string, max = 4096) {
  if (
    value.length > max ||
    // oxlint-disable-next-line no-control-regex -- Reject control bytes in a path.
    /[\x00-\x1f]/.test(value) ||
    value.startsWith("/") ||
    /^[A-Za-z]:/.test(value) ||
    value.includes("\\") ||
    value.split("/").includes("..")
  )
    throw new Error("Invalid Workspace Files path");
  return value;
}
function text(value: string, max: number) {
  if (
    value.length > max ||
    // oxlint-disable-next-line no-control-regex -- Reject control bytes in untrusted metadata.
    /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)
  )
    throw new Error("Invalid Workspace Files metadata");
  return value;
}
function listRequest(value: {
  protocolMajor: number;
  requestId: string;
  workspaceId: string;
  computerId: string;
  agentId: string;
  dirPath: string;
  includeHidden: boolean;
}): AgentWorkspaceFilesListRequest {
  if (value.protocolMajor !== 1) throw new Error("Invalid Workspace Files request");
  scopeIds(value);
  return {
    protocolMajor: 1,
    requestId: value.requestId,
    workspaceId: value.workspaceId,
    computerId: value.computerId,
    agentId: value.agentId,
    dirPath: relativePath(value.dirPath),
    includeHidden: value.includeHidden,
  };
}
function entry(value: {
  name: string;
  type: string;
  sizeBytes: bigint;
  modifiedAtMs: bigint;
}): AgentWorkspaceFileEntry {
  if (!["file", "dir", "symlink", "other"].includes(value.type))
    throw new Error("Invalid Workspace Files entry");
  if (
    value.sizeBytes > BigInt(Number.MAX_SAFE_INTEGER) ||
    value.modifiedAtMs > BigInt(Number.MAX_SAFE_INTEGER)
  )
    throw new Error("Invalid Workspace Files entry");
  return {
    name: text(value.name, 255),
    type: value.type as AgentWorkspaceFileEntry["type"],
    sizeBytes: Number(value.sizeBytes),
    modifiedAtMs: Number(value.modifiedAtMs),
  };
}
function validateStatusAndRoot(value: { status: string; rootPath: string }) {
  if (!["ok", "missing", "unreadable", "error"].includes(value.status))
    throw new Error("Invalid Workspace Files result");
  return {
    status: value.status as AgentWorkspaceFilesListResult["status"],
    // rootPath is an absolute filesystem path (only set when dirPath is ""), so it is
    // validated as plain metadata rather than as a workspace-relative path.
    rootPath: text(value.rootPath, 4096),
  };
}
function validateEntry(value: AgentWorkspaceFileEntry): AgentWorkspaceFileEntry {
  if (!["file", "dir", "symlink", "other"].includes(value.type))
    throw new Error("Invalid Workspace Files entry");
  if (
    !Number.isSafeInteger(value.sizeBytes) ||
    value.sizeBytes < 0 ||
    !Number.isSafeInteger(value.modifiedAtMs) ||
    value.modifiedAtMs < 0
  )
    throw new Error("Invalid Workspace Files entry");
  return {
    name: text(value.name, 255),
    type: value.type,
    sizeBytes: value.sizeBytes,
    modifiedAtMs: value.modifiedAtMs,
  };
}
function listResult(value: {
  status: string;
  rootPath: string;
  entries: { name: string; type: string; sizeBytes: bigint; modifiedAtMs: bigint }[];
}) {
  if (value.entries.length > 4096) throw new Error("Invalid Workspace Files result");
  return {
    ...validateStatusAndRoot(value),
    entries: value.entries.map(entry),
  };
}
/** A media type, `type/subtype`, as RFC 9110 spells it; the only shape this protocol ever puts in
 * `contentType`, so anything else is a payload the sender did not mean to send. */
const MEDIA_TYPE = /^[a-z]+\/[a-z0-9.+-]+$/i;

function bounded(bytes: Uint8Array, max = RPC_PAYLOAD_MAX_BYTES) {
  if (bytes.length > max) throw new Error("Workspace Files payload too large");
  return bytes;
}

/**
 * The image payload a read result carries: the media type that names the bytes, and the bytes
 * themselves. Empty on both sides for a text read, and one without the other is not a result this
 * protocol can produce — an image read is the only shape that fills them, and it always fills both.
 */
function readResultContent(value: { contentType: string; contentBase64: string }): {
  contentType: string;
  content: Uint8Array;
} {
  const contentType = text(value.contentType, 255);
  if (value.contentBase64 === "") {
    if (contentType !== "") throw new Error("Invalid Workspace File read result");
    return { contentType: "", content: new Uint8Array() };
  }
  // The two fields are set together: bytes with no media type to name them are not a payload this
  // protocol produces, and a reader could not tell what to do with them.
  if (!MEDIA_TYPE.test(contentType)) throw new Error("Invalid Workspace File read result");
  if (value.contentBase64.length > MAX_CONTENT_BASE64_LENGTH)
    throw new Error("Invalid Workspace File read result");
  const content = decodeBase64(value.contentBase64);
  if (content.length > MAX_CONTENT_BYTES) throw new Error("Invalid Workspace File read result");
  return { contentType, content };
}

export function encodeAgentWorkspaceFilesListRequest(
  value: AgentWorkspaceFilesListRequest,
): Uint8Array {
  return toBinary(
    AgentWorkspaceFilesListRequestSchema,
    create(AgentWorkspaceFilesListRequestSchema, {
      ...listRequest(value),
      messageType: LIST_REQUEST_TYPE,
    }),
  );
}
export function decodeAgentWorkspaceFilesListRequest(
  bytes: Uint8Array,
): AgentWorkspaceFilesListRequest {
  const value = fromBinary(AgentWorkspaceFilesListRequestSchema, bounded(bytes));
  if (value.messageType !== LIST_REQUEST_TYPE)
    throw new Error("Invalid Workspace Files request type");
  return listRequest(value);
}
export function encodeAgentWorkspaceFilesListResult(
  value: AgentWorkspaceFilesListResult,
): Uint8Array {
  const { status, rootPath } = validateStatusAndRoot(value);
  if (value.entries.length > 4096) throw new Error("Invalid Workspace Files result");
  const entries = value.entries.map(validateEntry);
  return bounded(
    toBinary(
      AgentWorkspaceFilesListResultSchema,
      create(AgentWorkspaceFilesListResultSchema, {
        ...listRequest(value),
        messageType: LIST_RESULT_TYPE,
        status,
        rootPath,
        entries: entries.map((e) => ({
          name: e.name,
          type: e.type,
          sizeBytes: BigInt(e.sizeBytes),
          modifiedAtMs: BigInt(e.modifiedAtMs),
        })),
      }),
    ),
  );
}
export function decodeAgentWorkspaceFilesListResult(
  bytes: Uint8Array,
): AgentWorkspaceFilesListResult {
  const value = fromBinary(AgentWorkspaceFilesListResultSchema, bounded(bytes));
  if (value.messageType !== LIST_RESULT_TYPE) throw new Error("Invalid Workspace Files result");
  return {
    ...listRequest(value),
    ...listResult(value),
  };
}

function readRequest(value: {
  protocolMajor: number;
  requestId: string;
  workspaceId: string;
  computerId: string;
  agentId: string;
  path: string;
}): AgentWorkspaceFileReadRequest {
  if (value.protocolMajor !== 1) throw new Error("Invalid Workspace File read request");
  scopeIds(value);
  return {
    protocolMajor: 1,
    requestId: value.requestId,
    workspaceId: value.workspaceId,
    computerId: value.computerId,
    agentId: value.agentId,
    path: relativePath(value.path),
  };
}

function deleteRequest(value: AgentWorkspaceDeleteRequest): AgentWorkspaceDeleteRequest {
  if (value.protocolMajor !== 1) throw new Error("Invalid Workspace Files delete request");
  scopeIds(value);
  return {
    protocolMajor: 1,
    requestId: value.requestId,
    workspaceId: value.workspaceId,
    computerId: value.computerId,
    agentId: value.agentId,
  };
}

function deleteStatus(value: string): AgentWorkspaceDeleteResult["status"] {
  if (!["ok", "missing", "unreadable", "error"].includes(value))
    throw new Error("Invalid Workspace Files delete result");
  return value as AgentWorkspaceDeleteResult["status"];
}

export function encodeAgentWorkspaceDeleteRequest(value: AgentWorkspaceDeleteRequest): Uint8Array {
  return toBinary(
    AgentWorkspaceDeleteRequestSchema,
    create(AgentWorkspaceDeleteRequestSchema, {
      ...deleteRequest(value),
      messageType: DELETE_REQUEST_TYPE,
    }),
  );
}

export function decodeAgentWorkspaceDeleteRequest(bytes: Uint8Array): AgentWorkspaceDeleteRequest {
  const value = fromBinary(AgentWorkspaceDeleteRequestSchema, bounded(bytes));
  if (value.messageType !== DELETE_REQUEST_TYPE)
    throw new Error("Invalid Workspace Files delete request type");
  return deleteRequest(value);
}

export function encodeAgentWorkspaceDeleteResult(value: AgentWorkspaceDeleteResult): Uint8Array {
  return bounded(
    toBinary(
      AgentWorkspaceDeleteResultSchema,
      create(AgentWorkspaceDeleteResultSchema, {
        ...deleteRequest(value),
        messageType: DELETE_RESULT_TYPE,
        status: deleteStatus(value.status),
      }),
    ),
  );
}

export function decodeAgentWorkspaceDeleteResult(bytes: Uint8Array): AgentWorkspaceDeleteResult {
  const value = fromBinary(AgentWorkspaceDeleteResultSchema, bounded(bytes));
  if (value.messageType !== DELETE_RESULT_TYPE)
    throw new Error("Invalid Workspace Files delete result type");
  return { ...deleteRequest(value), status: deleteStatus(value.status) };
}
export function encodeAgentWorkspaceFileReadRequest(
  value: AgentWorkspaceFileReadRequest,
): Uint8Array {
  return toBinary(
    AgentWorkspaceFileReadRequestSchema,
    create(AgentWorkspaceFileReadRequestSchema, {
      ...readRequest(value),
      messageType: READ_REQUEST_TYPE,
    }),
  );
}
export function decodeAgentWorkspaceFileReadRequest(
  bytes: Uint8Array,
): AgentWorkspaceFileReadRequest {
  const value = fromBinary(AgentWorkspaceFileReadRequestSchema, bounded(bytes));
  if (value.messageType !== READ_REQUEST_TYPE)
    throw new Error("Invalid Workspace File read request type");
  return readRequest(value);
}
export function encodeAgentWorkspaceFileReadResult(
  value: AgentWorkspaceFileReadResult,
): Uint8Array {
  if (!["ok", "missing", "unreadable", "binary", "too_large", "error"].includes(value.status))
    throw new Error("Invalid Workspace File read result");
  if (
    value.sizeBytes < 0 ||
    !Number.isSafeInteger(value.sizeBytes) ||
    value.text.length > MAX_TEXT_BYTES
  )
    throw new Error("Invalid Workspace File read result");
  const { contentType, content } = readResultContent(value);
  if (value.text !== "" && content.length > 0)
    throw new Error("Invalid Workspace File read result");
  return bounded(
    toBinary(
      AgentWorkspaceFileReadResultSchema,
      create(AgentWorkspaceFileReadResultSchema, {
        ...readRequest(value),
        messageType: READ_RESULT_TYPE,
        status: value.status,
        sizeBytes: BigInt(value.sizeBytes),
        modifiedAtMs: BigInt(value.modifiedAtMs),
        text: value.text,
        contentType,
        content,
      }),
    ),
    MAX_READ_RESULT_BYTES,
  );
}
export function decodeAgentWorkspaceFileReadResult(
  bytes: Uint8Array,
): AgentWorkspaceFileReadResult {
  const value = fromBinary(
    AgentWorkspaceFileReadResultSchema,
    bounded(bytes, MAX_READ_RESULT_BYTES),
  );
  if (
    value.messageType !== READ_RESULT_TYPE ||
    !["ok", "missing", "unreadable", "binary", "too_large", "error"].includes(value.status) ||
    value.sizeBytes > BigInt(Number.MAX_SAFE_INTEGER) ||
    value.modifiedAtMs > BigInt(Number.MAX_SAFE_INTEGER)
  )
    throw new Error("Invalid Workspace File read result");
  const text_ = text(value.text, MAX_TEXT_BYTES);
  const { contentType, content } = readResultContent({
    contentType: value.contentType,
    contentBase64: value.content.length > 0 ? encodeBase64(value.content) : "",
  });
  if (text_ !== "" && content.length > 0) throw new Error("Invalid Workspace File read result");
  return {
    ...readRequest(value),
    status: value.status as AgentWorkspaceFileReadResult["status"],
    sizeBytes: Number(value.sizeBytes),
    modifiedAtMs: Number(value.modifiedAtMs),
    text: text_,
    contentType,
    contentBase64: content.length > 0 ? encodeBase64(content) : "",
  };
}
