/**
 * Wire contract for `coforge mention pending`, `coforge mention notify` and `coforge mention add`:
 * the sender's mentions
 * that reached no one because the target was outside the conversation at send time, and what the
 * sender asked to do about them. Uses the same `{ ok: false, errorCode, error }` error envelope as
 * the `profile` and `user info` routes.
 */

import { z } from "zod";
import type { AgentPendingMentionAction } from "#src/internal/local-daemon";

/** One of the sender's still-pending mentions, with the channel it was sent in (by name). */
export type AgentMentionPendingAction = AgentPendingMentionAction & { channelName: string };

/** Rows `GET /api/agent/v1/mention-actions/pending` returns without a `limit`, and the most it
 * will return however large a `limit` is asked for. */
export const MENTION_PENDING_DEFAULT_LIMIT = 50;
export const MENTION_PENDING_MAX_LIMIT = 100;

export type AgentMentionPendingRequest = { limit?: number };

/** Response for `GET /api/agent/v1/mention-actions/pending[?limit=<n>]`: the oldest pending
 * actions that still allow an action first; `hasMore` says whether more of them exist beyond this
 * page (the route has no cursor). `noLongerActionable` counts the pending mentions that allow
 * none, which take no place in the page and expire on their own. */
export type AgentMentionPendingResponse = {
  ok: true;
  pendingMentionActions: AgentMentionPendingAction[];
  hasMore?: boolean;
  noLongerActionable?: number;
};

/** The actions a sender can request for its pending mentions: `notify` reaches the target
 * without making it a member; `add` makes it a member of the channel. */
export const AGENT_MENTION_ACTION_KINDS = ["notify", "add"] as const;
export type AgentMentionActionKind = (typeof AGENT_MENTION_ACTION_KINDS)[number];

export function isAgentMentionActionKind(value: unknown): value is AgentMentionActionKind {
  return (AGENT_MENTION_ACTION_KINDS as readonly unknown[]).includes(value);
}

/** Request body for `POST /api/agent/v1/mention-actions/execute`: one action on 1–20 resolution ids. */
export type AgentMentionExecuteRequest = {
  action: AgentMentionActionKind;
  resolutionIds: string[];
};

/** The outcome for one requested resolution id: `queued` is a notify's success, `delivered` an
 * add's. */
export type AgentMentionActionResult = {
  resolutionId: string;
  status: string;
  action?: string;
  reason?: string;
  messageId?: string;
  channelId?: string;
  targetType?: "user" | "agent";
  targetId?: string;
  /** The `@handle` the sender wrote, without the `@`. */
  targetHandle?: string;
};

/** Response for `POST /api/agent/v1/mention-actions/execute`. */
export type AgentMentionExecuteResponse = {
  ok: true;
  action: AgentMentionActionKind;
  results: AgentMentionActionResult[];
};

/** Most resolution ids one request may name. */
export const AGENT_MENTION_ACTION_MAX_IDS = 20;

export const AGENT_MENTION_ACTION_ERROR_CODES = ["invalid_request"] as const;
export type AgentMentionActionErrorCode = (typeof AGENT_MENTION_ACTION_ERROR_CODES)[number];

export type AgentMentionActionErrorResponse = {
  ok: false;
  errorCode: AgentMentionActionErrorCode;
  error: string;
};

const targetTypeSchema = z.enum(["user", "agent"]);

const pendingActionSchema = z.looseObject({
  resolutionId: z.string(),
  messageId: z.string(),
  targetType: targetTypeSchema,
  targetHandle: z.string(),
  targetAvatarUrl: z.string().nullable(),
  reason: z.literal("not_member"),
  availableActions: z.array(z.string()),
  expiresAt: z.string(),
  channelName: z.string(),
});

const actionResultSchema = z.looseObject({
  resolutionId: z.string(),
  status: z.string(),
  action: z.string().optional(),
  reason: z.string().optional(),
  messageId: z.string().optional(),
  channelId: z.string().optional(),
  targetType: targetTypeSchema.optional(),
  targetId: z.string().optional(),
});

const mentionPendingResponseSchema = z.object({
  ok: z.literal(true),
  pendingMentionActions: z.array(pendingActionSchema),
  hasMore: z.boolean().optional().catch(undefined),
  noLongerActionable: z.int().min(0).optional().catch(undefined),
});

const mentionExecuteResponseSchema = z.object({
  ok: z.literal(true),
  action: z.enum(AGENT_MENTION_ACTION_KINDS),
  results: z.array(actionResultSchema),
});

const mentionActionErrorResponseSchema = z.object({
  ok: z.literal(false),
  errorCode: z.enum(AGENT_MENTION_ACTION_ERROR_CODES),
  error: z.string(),
});

export function decodeAgentMentionPendingResponse(value: unknown): AgentMentionPendingResponse {
  const parsed = mentionPendingResponseSchema.safeParse(value);
  if (!parsed.success) throw new Error("invalid Agent mention pending response");
  const { hasMore, noLongerActionable, ...rest } = parsed.data;
  return {
    ...rest,
    ...(hasMore !== undefined ? { hasMore } : {}),
    ...(noLongerActionable !== undefined ? { noLongerActionable } : {}),
  };
}

export function decodeAgentMentionExecuteResponse(value: unknown): AgentMentionExecuteResponse {
  const parsed = mentionExecuteResponseSchema.safeParse(value);
  if (!parsed.success) throw new Error("invalid Agent mention action response");
  return parsed.data;
}

export function decodeAgentMentionActionErrorResponse(
  value: unknown,
): AgentMentionActionErrorResponse | undefined {
  const parsed = mentionActionErrorResponseSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
