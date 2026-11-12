import { agentApiRoutes } from "@lrm/coforge-sdk/agent";
import { taskConversationHttpRequest } from "@lrm/coforge-sdk/agent";
import type {
  AgentAppRequest,
  AgentArtifactRequest,
  AgentLabelWriteRequest,
  AgentTaskConversationRequest,
} from "@lrm/coforge-sdk/agent";
import { agentAppCloudRequest } from "./agent-app-cloud-request";
import { agentHeaders, agentHttpFetch } from "./agent-http-wire";

/** What the connection supplies to one Agent request it forwards as it is. */
export type ForwardPorts = {
  assertConnected(): void;
  endpoint(what: string, path: string): string;
  keys(agentApiKey: string): { agentApiKey: string; daemonApiKey: string };
};

/** One cloud request for an Agent, sent on as it is; the cloud's response is the Agent's answer. */
export function forwardAgentRequest(
  ports: ForwardPorts,
  what: string,
  { method, path, body }: { method?: string; path: string; body?: string },
  agentApiKey: string,
): Promise<Response> {
  ports.assertConnected();
  return agentHttpFetch(ports.endpoint(what, path), {
    decompress: false,
    method,
    headers: agentHeaders(ports.keys(agentApiKey), body !== undefined),
    ...(body === undefined ? {} : { body }),
  });
}

/** One artifact file upload: the sha256 its bytes are named by, and the Agent's own request
 * carrying them. */
export type AgentArtifactUploadRequest = { sha256: string; request: Request };

/** One artifact file download: the file's path in the artifact, at `version` or the current one. */
export type AgentArtifactDownloadRequest = { artifact: string; path: string; version?: number };

/** An artifact call forwarded as it is: a JSON operation, or the bytes of one file either way. */
export type AgentArtifactCall =
  | AgentArtifactRequest
  | ({ file: "upload" } & AgentArtifactUploadRequest)
  | ({ file: "download" } & AgentArtifactDownloadRequest);

/** `coforge attachment view`: the bytes and their encoding/length headers, unchanged. */
export function agentAttachment(
  ports: ForwardPorts,
  attachmentId: string,
  agentApiKey: string,
): Promise<Response> {
  return forwardAgentRequest(
    ports,
    "Agent attachment",
    { path: agentApiRoutes.cloud.attachments.path(attachmentId) },
    agentApiKey,
  );
}

/**
 * Forwards a multipart upload to the cloud attachment-upload route. Buffered to a `Blob`
 * rather than streamed: the local proxy already caps the body well under the size the daemon
 * can hold in memory, and buffering avoids depending on `duplex: "half"` for a streamed
 * `fetch` body. The original request's `content-type` (its multipart boundary) is forwarded
 * unchanged; only the Agent-scoped authorization headers are added.
 */
export async function agentAttachmentUpload(
  ports: ForwardPorts,
  request: Request,
  agentApiKey: string,
): Promise<Response> {
  ports.assertConnected();
  const contentType = request.headers.get("content-type");
  if (!contentType) throw new Error("multipart content-type is missing");
  const body = await request.blob();
  return agentHttpFetch(
    ports.endpoint("Agent attachment upload", agentApiRoutes.cloud.attachments.upload.path),
    {
      decompress: false,
      method: agentApiRoutes.cloud.attachments.upload.method,
      headers: { ...agentHeaders(ports.keys(agentApiKey)), "content-type": contentType },
      body,
    },
  );
}

/**
 * The direct-upload session routes are plain JSON, unlike the multipart upload above; each simply
 * forwards its body (if any) to the matching cloud route with the same Agent-scoped headers.
 */
export function agentAttachmentUploadSessionCreate(
  ports: ForwardPorts,
  body: unknown,
  agentApiKey: string,
): Promise<Response> {
  const { create } = agentApiRoutes.cloud.attachmentUploadSessions;
  return forwardAgentRequest(
    ports,
    "Agent upload session create",
    { method: create.method, path: create.path, body: JSON.stringify(body) },
    agentApiKey,
  );
}

export function agentAttachmentUploadSessionComplete(
  ports: ForwardPorts,
  uploadId: string,
  agentApiKey: string,
): Promise<Response> {
  const { complete } = agentApiRoutes.cloud.attachmentUploadSessions;
  return forwardAgentRequest(
    ports,
    "Agent upload session complete",
    { method: complete.method, path: complete.path(uploadId) },
    agentApiKey,
  );
}

export function agentAttachmentUploadSessionCancel(
  ports: ForwardPorts,
  uploadId: string,
  agentApiKey: string,
): Promise<Response> {
  const { cancel } = agentApiRoutes.cloud.attachmentUploadSessions;
  return forwardAgentRequest(
    ports,
    "Agent upload session cancel",
    { method: cancel.method, path: cancel.path(uploadId) },
    agentApiKey,
  );
}

export function agentAttachmentUploadSessionGet(
  ports: ForwardPorts,
  uploadId: string,
  agentApiKey: string,
): Promise<Response> {
  const { get } = agentApiRoutes.cloud.attachmentUploadSessions;
  return forwardAgentRequest(
    ports,
    "Agent upload session get",
    { path: get.path(uploadId) },
    agentApiKey,
  );
}

/** `coforge app list|token`: forwarded as it is. */
export function agentApp(
  ports: ForwardPorts,
  request: AgentAppRequest,
  agentApiKey: string,
): Promise<Response> {
  return forwardAgentRequest(
    ports,
    `Agent app ${request.operation}`,
    agentAppCloudRequest(request),
    agentApiKey,
  );
}

/** `coforge task view|read|reply|follow|unfollow|list --following`: forwarded as it is. */
export function agentTaskConversation(
  ports: ForwardPorts,
  request: AgentTaskConversationRequest,
  agentApiKey: string,
): Promise<Response> {
  return forwardAgentRequest(
    ports,
    `Agent task ${request.route}`,
    taskConversationHttpRequest(agentApiRoutes.cloud.taskConversations, request),
    agentApiKey,
  );
}

/** `coforge artifact create|read|push|history|revert`: forwarded as it is (task #385). */
/** `coforge label create|rename|update|delete|restore` (task #508), the cloud's answer as it came. */
export function agentLabel(
  ports: ForwardPorts,
  request: AgentLabelWriteRequest,
  agentApiKey: string,
): Promise<Response> {
  const route = agentApiRoutes.cloud.labelWrite;
  return forwardAgentRequest(
    ports,
    `Agent label ${request.operation}`,
    { method: route.method, path: route.path, body: JSON.stringify(request) },
    agentApiKey,
  );
}

export function agentArtifact(
  ports: ForwardPorts,
  call: AgentArtifactCall,
  agentApiKey: string,
): Promise<Response> {
  if ("file" in call)
    return call.file === "upload"
      ? artifactUpload(ports, call, agentApiKey)
      : artifactDownload(ports, call, agentApiKey);
  const route = agentApiRoutes.cloud.artifacts;
  return forwardAgentRequest(
    ports,
    `Agent artifact ${call.operation}`,
    { method: route.method, path: route.path, body: JSON.stringify(call) },
    agentApiKey,
  );
}

/**
 * `coforge artifact push|create` uploading a file the cloud asked for (`missing`): the bytes go
 * to the cloud as they came, buffered because the local proxy already caps them at the artifact
 * upload limit.
 */
async function artifactUpload(
  ports: ForwardPorts,
  { sha256, request }: AgentArtifactUploadRequest,
  agentApiKey: string,
): Promise<Response> {
  ports.assertConnected();
  const route = agentApiRoutes.cloud.artifactFiles.upload;
  const body = await request.blob();
  return agentHttpFetch(ports.endpoint("Agent artifact upload", route.path(sha256)), {
    decompress: false,
    method: route.method,
    headers: {
      ...agentHeaders(ports.keys(agentApiKey)),
      "content-type": request.headers.get("content-type") ?? "application/octet-stream",
    },
    body,
  });
}

/** `coforge artifact pull|download`: one file's bytes and content type, answered as they came. */
function artifactDownload(
  ports: ForwardPorts,
  { artifact, path, version }: AgentArtifactDownloadRequest,
  agentApiKey: string,
): Promise<Response> {
  const route = agentApiRoutes.cloud.artifactFiles.download;
  return forwardAgentRequest(
    ports,
    "Agent artifact download",
    {
      path: `${route.path(artifact, path)}${version === undefined ? "" : `?version=${version}`}`,
    },
    agentApiKey,
  );
}
