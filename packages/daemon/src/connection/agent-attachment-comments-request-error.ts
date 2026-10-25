import type { AgentAttachmentCommentsErrorCode } from "@lrm/coforge-sdk/agent";

/**
 * A well-formed `{ ok: false, errorCode, error }` response from attachment comments
 * (`GET /api/agent/v1/attachments/:attachmentId/comments`). Carried through verbatim to the CLI
 * instead of being folded into the generic proxy-failure taxonomy.
 */
export class AgentAttachmentCommentsRequestError extends Error {
  readonly errorCode: AgentAttachmentCommentsErrorCode;
  readonly status: number;

  constructor(errorCode: AgentAttachmentCommentsErrorCode, message: string, status: number) {
    super(message);
    this.name = "AgentAttachmentCommentsRequestError";
    this.errorCode = errorCode;
    this.status = status;
  }
}
