/**
 * Wire contract for `coforge attachment comments`
 * (`GET /api/agent/v1/attachments/:attachmentId/comments[?limit=<n>][&before=<n>]`): the root
 * comments on one attachment, oldest first. Read-only: no target addresses the discussion yet.
 */

import { isMessageSenderKind, isRecord, type MessageSenderKind } from "../internal";

/** The most one page holds; a larger `limit` is refused. */
export const AGENT_ATTACHMENT_COMMENTS_MAX_LIMIT = 100;
export const AGENT_ATTACHMENT_COMMENTS_DEFAULT_LIMIT = 100;

export type AgentAttachmentCommentsRequest = {
  attachmentId: string;
  limit?: number;
  /** The `sequence` of the oldest comment of the page just read: the page before it. */
  before?: number;
};

/** Where in the attachment a comment points; `type` is open, `data` is the type's own fields. */
export type AgentAttachmentCommentAnchor = { type: string; data: Record<string, unknown> };

export type AgentAttachmentComment = {
  id: string;
  sequence: number;
  /** As on every Agent-facing message: `human` for a person. */
  senderKind: MessageSenderKind;
  senderName: string;
  senderHandle?: string;
  /** Mentions read back as text, as in every Agent-facing message. */
  body: string;
  createdAt: string;
  reactions: { emoji: string; count: number }[];
  anchor: AgentAttachmentCommentAnchor | null;
  /** Any ✅ reaction marks the comment resolved. */
  resolved: boolean;
};

export const AGENT_ATTACHMENT_COMMENT_DISABLED_REASONS = [
  "archived",
  "read-only",
  "not-member",
] as const;
export type AgentAttachmentCommentDisabledReason =
  (typeof AGENT_ATTACHMENT_COMMENT_DISABLED_REASONS)[number];

export type AgentAttachmentCommentsResponse = {
  ok: true;
  attachmentId: string;
  /** Whether the Agent may add a comment, and why not when it may not. */
  viewer: {
    canComment: boolean;
    canResolve: boolean;
    resolveAction?: { type: "reaction"; emoji: "✅" };
    reason?: AgentAttachmentCommentDisabledReason;
  };
  comments: AgentAttachmentComment[];
  hasOlder: boolean;
};

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

function isResolveAction(
  value: unknown,
): value is NonNullable<AgentAttachmentCommentsResponse["viewer"]["resolveAction"]> {
  return isRecord(value) && value.type === "reaction" && value.emoji === "✅";
}

function isAnchor(value: unknown): value is AgentAttachmentCommentAnchor {
  return isRecord(value) && typeof value.type === "string" && isRecord(value.data);
}

function isComment(value: unknown): value is AgentAttachmentComment {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    isCount(value.sequence) &&
    isMessageSenderKind(value.senderKind) &&
    typeof value.senderName === "string" &&
    (value.senderHandle === undefined || typeof value.senderHandle === "string") &&
    typeof value.body === "string" &&
    typeof value.createdAt === "string" &&
    Array.isArray(value.reactions) &&
    value.reactions.every(
      (reaction) =>
        isRecord(reaction) && typeof reaction.emoji === "string" && isCount(reaction.count),
    ) &&
    (value.anchor === null || isAnchor(value.anchor)) &&
    typeof value.resolved === "boolean"
  );
}

export function decodeAgentAttachmentCommentsResponse(
  value: unknown,
): AgentAttachmentCommentsResponse {
  if (
    !isRecord(value) ||
    value.ok !== true ||
    typeof value.attachmentId !== "string" ||
    !isRecord(value.viewer) ||
    typeof value.viewer.canComment !== "boolean" ||
    typeof value.viewer.canResolve !== "boolean" ||
    (value.viewer.canResolve
      ? !isResolveAction(value.viewer.resolveAction)
      : value.viewer.resolveAction !== undefined) ||
    !(
      value.viewer.reason === undefined ||
      (AGENT_ATTACHMENT_COMMENT_DISABLED_REASONS as readonly unknown[]).includes(
        value.viewer.reason,
      )
    ) ||
    !Array.isArray(value.comments) ||
    !value.comments.every(isComment) ||
    typeof value.hasOlder !== "boolean"
  )
    throw new Error("invalid Agent attachment comments response");
  return {
    ok: true,
    attachmentId: value.attachmentId,
    viewer: {
      canComment: value.viewer.canComment,
      canResolve: value.viewer.canResolve,
      ...(isResolveAction(value.viewer.resolveAction)
        ? { resolveAction: value.viewer.resolveAction }
        : {}),
      ...(value.viewer.reason === undefined
        ? {}
        : { reason: value.viewer.reason as AgentAttachmentCommentDisabledReason }),
    },
    comments: value.comments,
    hasOlder: value.hasOlder,
  };
}

/** The refusals of the route, answered as `{ ok: false, errorCode, error }` like Manual and mention
 * delivery. `NOT_FOUND` also covers an attachment the Agent may not read. */
export const AGENT_ATTACHMENT_COMMENTS_ERROR_CODES = ["INVALID_INPUT", "NOT_FOUND"] as const;
export type AgentAttachmentCommentsErrorCode =
  (typeof AGENT_ATTACHMENT_COMMENTS_ERROR_CODES)[number];

export function decodeAgentAttachmentCommentsErrorResponse(
  value: unknown,
): { ok: false; errorCode: AgentAttachmentCommentsErrorCode; error: string } | undefined {
  if (
    !isRecord(value) ||
    value.ok !== false ||
    !(AGENT_ATTACHMENT_COMMENTS_ERROR_CODES as readonly unknown[]).includes(value.errorCode) ||
    typeof value.error !== "string"
  )
    return undefined;
  return {
    ok: false,
    errorCode: value.errorCode as AgentAttachmentCommentsErrorCode,
    error: value.error,
  };
}
