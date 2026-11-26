/**
 * Wire contract for `coforge attachment comments`
 * (`GET /api/agent/v1/attachments/:attachmentId/comments[?limit=<n>][&before=<n>]`): the root
 * comments on one attachment, oldest first. Read-only: no target addresses the discussion yet.
 */

import { z } from "zod";
import { isMessageSenderKind, type MessageSenderKind } from "../internal";

/** The most one page holds; a larger `limit` is refused. */
export const AGENT_ATTACHMENT_COMMENTS_MAX_LIMIT = 100;
export const AGENT_ATTACHMENT_COMMENTS_DEFAULT_LIMIT = 100;

export type AgentAttachmentCommentsRequest = {
  attachmentId: string;
  limit?: number;
  /** The `sequence` of the oldest comment of the page just read: the page before it. */
  before?: number;
};

/** Any JSON value: what the anchor's `data` bag may hold — the Web stores it in a JsonB column. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** Where in the attachment a comment points; `type` is open, `data` is the type's own fields. */
export type AgentAttachmentCommentAnchor = { type: string; data: Record<string, JsonValue> };

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

const countSchema = z.int().min(0);

const resolveActionSchema = z.looseObject({
  type: z.literal("reaction"),
  emoji: z.literal("✅"),
});

const attachmentCommentAnchorSchema = z.looseObject({
  type: z.string(),
  data: z.record(z.string(), z.unknown()),
});

const attachmentCommentSchema = z.looseObject({
  id: z.string(),
  sequence: countSchema,
  senderKind: z.custom<MessageSenderKind>((value) => isMessageSenderKind(value)),
  senderName: z.string(),
  senderHandle: z.string().optional(),
  body: z.string(),
  createdAt: z.string(),
  reactions: z.array(
    z.looseObject({
      emoji: z.string(),
      count: countSchema,
    }),
  ),
  anchor: attachmentCommentAnchorSchema.nullable(),
  resolved: z.boolean(),
});

const attachmentCommentsViewerSchema = z
  .object({
    canComment: z.boolean(),
    canResolve: z.boolean(),
    resolveAction: resolveActionSchema.optional(),
    reason: z.enum(AGENT_ATTACHMENT_COMMENT_DISABLED_REASONS).optional(),
  })
  .refine((viewer) =>
    viewer.canResolve ? viewer.resolveAction !== undefined : viewer.resolveAction === undefined,
  );

const attachmentCommentsResponseSchema = z.object({
  ok: z.literal(true),
  attachmentId: z.string(),
  viewer: attachmentCommentsViewerSchema,
  comments: z.array(attachmentCommentSchema),
  hasOlder: z.boolean(),
});

export function isAttachmentCommentAnchor(value: unknown): value is AgentAttachmentCommentAnchor {
  return attachmentCommentAnchorSchema.safeParse(value).success;
}

export function decodeAgentAttachmentCommentsResponse(
  value: unknown,
): AgentAttachmentCommentsResponse {
  const parsed = attachmentCommentsResponseSchema.safeParse(value);
  if (!parsed.success) throw new Error("invalid Agent attachment comments response");
  return parsed.data as AgentAttachmentCommentsResponse;
}

/** The refusals of the route, answered as `{ ok: false, errorCode, error }` like Manual and mention
 * delivery. `NOT_FOUND` also covers an attachment the Agent may not read. */
export const AGENT_ATTACHMENT_COMMENTS_ERROR_CODES = ["INVALID_INPUT", "NOT_FOUND"] as const;
export type AgentAttachmentCommentsErrorCode =
  (typeof AGENT_ATTACHMENT_COMMENTS_ERROR_CODES)[number];

const attachmentCommentsErrorResponseSchema = z.object({
  ok: z.literal(false),
  errorCode: z.enum(AGENT_ATTACHMENT_COMMENTS_ERROR_CODES),
  error: z.string(),
});

export function decodeAgentAttachmentCommentsErrorResponse(
  value: unknown,
): { ok: false; errorCode: AgentAttachmentCommentsErrorCode; error: string } | undefined {
  const parsed = attachmentCommentsErrorResponseSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
