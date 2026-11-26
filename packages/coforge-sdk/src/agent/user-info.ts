/**
 * Wire contract for `coforge user info <name>`: narrow visible facts about one human or Agent in
 * the caller's Workspace, plus the public channels both the caller and the target belong to.
 * Uses the same `{ ok: false, errorCode, error }` error envelope as the Agent Manual routes.
 */

import { z } from "zod";

export type AgentUserKind = "human" | "agent";

export type AgentUserInfoRequest = { name: string };

/** Live lifecycle, sourced from the same Agent display projection the Workspace Agents list
 * uses (`agent-display.server.ts`); "unknown" when the Agent has no assigned Computer or the
 * display snapshot could not be read. Absent entirely for a human. */
export type AgentUserStatus = "online" | "offline" | "unknown";

export type AgentUserInfo = {
  kind: AgentUserKind;
  id: string;
  name: string;
  displayName: string;
  description: string;
  /** Workspace role for a human; the Agent's own server role for an Agent. Never
   * `null` in practice today (both default to `"member"`), but typed nullable defensively. */
  role: string | null;
  isSelf: boolean;
  /** Effective account time zone for a human, when known. */
  timeZone?: string;
  /** Agent-only fields below; absent for a human. */
  computerName?: string;
  status?: AgentUserStatus;
  /** Present only when there is a persisted reason the Agent will not respond even while its
   * process may be reachable (`stoppedAt`, surfaced only while the display itself
   * already reads offline — never a transient in-flight control state). */
  availability?: string;
};

export type AgentUserInfoMembership = {
  channel: string;
  /** The target's own stored `ConversationMember.channelRole`; absent when unknown. */
  role?: string;
};

/** Response for `GET /api/agent/v1/users/:name`. */
export type AgentUserInfoResponse = {
  ok: true;
  user: AgentUserInfo;
  memberships: AgentUserInfoMembership[];
};

/** `agent_not_visible`: the name resolves to a private Agent the caller cannot see —
 * a stable, distinct outcome from `user_not_found` (which also covers a name that genuinely
 * matches nothing). Reused by `profile show` (`profile.ts`). */
export const AGENT_USER_INFO_ERROR_CODES = ["user_not_found", "agent_not_visible"] as const;
export type AgentUserInfoErrorCode = (typeof AGENT_USER_INFO_ERROR_CODES)[number];

export type AgentUserInfoErrorResponse = {
  ok: false;
  errorCode: AgentUserInfoErrorCode;
  error: string;
};

const userInfoErrorResponseSchema = z.object({
  ok: z.literal(false),
  errorCode: z.enum(AGENT_USER_INFO_ERROR_CODES),
  error: z.string(),
});

const userInfoMembershipSchema = z.looseObject({
  channel: z.string(),
  role: z.string().optional(),
});

const userInfoMembershipsSchema = z.array(userInfoMembershipSchema);

const userInfoSchema = z.looseObject({
  kind: z.enum(["human", "agent"]),
  id: z.string(),
  name: z.string(),
  displayName: z.string(),
  description: z.string(),
  role: z.string().nullable(),
  isSelf: z.boolean(),
  timeZone: z.string().optional(),
});

const userInfoEnvelopeSchema = z.looseObject({
  ok: z.literal(true),
  user: z.unknown().optional(),
  memberships: z.unknown().optional(),
});

export function decodeAgentUserInfoErrorResponse(
  value: unknown,
): AgentUserInfoErrorResponse | undefined {
  const parsed = userInfoErrorResponseSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function decodeAgentUserInfoResponse(value: unknown): AgentUserInfoResponse {
  const envelope = userInfoEnvelopeSchema.safeParse(value);
  if (!envelope.success) throw new Error("invalid Agent user info response");
  const { user, memberships } = envelope.data;
  if (!user || typeof user !== "object" || Array.isArray(user))
    throw new Error("invalid Agent user info response: missing user");
  const parsedUser = userInfoSchema.safeParse(user);
  if (!parsedUser.success) throw new Error("invalid Agent user info response: malformed user");
  const parsedMemberships = userInfoMembershipsSchema.safeParse(memberships);
  if (!parsedMemberships.success)
    throw new Error("invalid Agent user info response: malformed memberships");
  return {
    ok: true,
    user: parsedUser.data as AgentUserInfo,
    memberships: parsedMemberships.data,
  };
}
