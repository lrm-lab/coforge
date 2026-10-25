import { createFileRoute } from "@tanstack/react-router";
import {
  AGENT_ATTACHMENT_COMMENTS_DEFAULT_LIMIT,
  AGENT_ATTACHMENT_COMMENTS_MAX_LIMIT,
  type AgentAttachmentCommentsErrorCode,
  type AgentAttachmentCommentsRequest,
  type AgentAttachmentCommentsResponse,
} from "@lrm/coforge-sdk/agent";
import { UUID_LIKE_PATTERN } from "@lrm/coforge-sdk/internal";
import { isAppErrorCode } from "#src/lib/app-error";
import { agentAuthMiddleware } from "#src/server/agents/agent-http-middleware.server";
import { readAgentAttachmentComments } from "#src/server/attachments/agent-attachment-comments.server";

const refusal = (errorCode: AgentAttachmentCommentsErrorCode, error: string, status: number) =>
  Response.json({ ok: false, errorCode, error }, { status });

/**
 * `GET /api/agent/v1/attachments/:attachmentId/comments[?limit=<n>][&before=<n>]` — the root
 * comments on an attachment, oldest first. `before` is the `sequence` of the oldest comment of the
 * page just read. An attachment the Agent may not read answers as one that does not exist.
 */
export async function handleAgentAttachmentCommentsGet(
  request: Request,
  attachmentId: string,
  read: (options: AgentAttachmentCommentsRequest) => Promise<AgentAttachmentCommentsResponse>,
): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const limit = params.has("limit")
    ? Number(params.get("limit"))
    : AGENT_ATTACHMENT_COMMENTS_DEFAULT_LIMIT;
  const before = params.has("before") ? Number(params.get("before")) : undefined;
  if (!UUID_LIKE_PATTERN.test(attachmentId))
    return refusal("INVALID_INPUT", "the attachment id must be a full UUID", 400);
  if (!Number.isInteger(limit) || limit < 1 || limit > AGENT_ATTACHMENT_COMMENTS_MAX_LIMIT)
    return refusal(
      "INVALID_INPUT",
      `limit must be an integer from 1 to ${AGENT_ATTACHMENT_COMMENTS_MAX_LIMIT}`,
      400,
    );
  if (before !== undefined && (!Number.isSafeInteger(before) || before < 1))
    return refusal("INVALID_INPUT", "before must be a positive integer", 400);
  try {
    return Response.json(await read({ attachmentId, limit, before }));
  } catch (error) {
    if (isAppErrorCode(error, "NOT_FOUND"))
      return refusal("NOT_FOUND", "attachment not found", 404);
    throw error;
  }
}

export const Route = createFileRoute("/api/agent/v1/attachments/$attachmentId/comments")({
  server: {
    middleware: [agentAuthMiddleware],
    handlers: {
      GET: ({ request, params, context: { principal, db } }) =>
        handleAgentAttachmentCommentsGet(request, params.attachmentId, (options) =>
          readAgentAttachmentComments(db, principal, options),
        ),
    },
  },
});
