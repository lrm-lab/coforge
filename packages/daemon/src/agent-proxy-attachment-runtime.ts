import type { AgentRequestForwarder } from "#src/daemon-runtime/agent-request-forwarder";
import type { AgentProxyRuntime } from "./agent-proxy-runtime";

/** The proxy's attachment handlers: the file, its upload, the upload sessions and the comments,
 * each reaching the forwarder when the request arrives. */
export const attachmentRuntime = (agentApi: () => AgentRequestForwarder) =>
  ({
    agentAttachment: async (...args) => agentApi().agentAttachment(...args),
    attachmentComments: async (...args) => agentApi().attachmentComments(...args),
    agentAttachmentUpload: async (...args) => agentApi().agentAttachmentUpload(...args),
    agentAttachmentUploadSessionCreate: async (...args) =>
      agentApi().agentAttachmentUploadSessionCreate(...args),
    agentAttachmentUploadSessionComplete: async (...args) =>
      agentApi().agentAttachmentUploadSessionComplete(...args),
    agentAttachmentUploadSessionCancel: async (...args) =>
      agentApi().agentAttachmentUploadSessionCancel(...args),
    agentAttachmentUploadSessionGet: async (...args) =>
      agentApi().agentAttachmentUploadSessionGet(...args),
  }) satisfies Partial<AgentProxyRuntime>;
