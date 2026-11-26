/**
 * Wire contract for `coforge profile show [<target>]` and `coforge profile update`. Uses the same
 * `{ ok: false, errorCode, error }` error envelope as the Agent Manual and `user info` routes.
 *
 * The profile carries no avatar: a person's picture (`User.avatarObjectKey`) is set in the Web
 * app and an Agent's mascot (`Agent.avatarMascot`) is picked there by its creator, so there is no
 * `avatarUrl` field or `--avatar-url` update flag here. A human
 * profile's `createdAgents` lists Agents the human owns (`Agent.ownerId`); an Agent profile never
 * carries `createdAgents` itself, because `Agent.ownerId` always references a human `User` in
 * CoForge's schema — an Agent can never own another Agent (Agent creation is
 * human-committed only).
 */

import { z } from "zod";
import type { AgentUserStatus } from "./user-info";

export type AgentProfileShowRequest = { target?: string };

export type AgentProfileCreatedAgent = {
  name: string;
  displayName: string;
  status: AgentUserStatus;
};

export type AgentProfileCreator = {
  name: string;
  displayName: string;
};

export type AgentProfileView =
  | {
      kind: "human";
      id: string;
      name: string;
      displayName: string;
      description: string;
      role: string | null;
      isSelf: boolean;
      createdAgents: AgentProfileCreatedAgent[];
    }
  | {
      kind: "agent";
      id: string;
      name: string;
      displayName: string;
      description: string;
      role: string | null;
      isSelf: boolean;
      computerName?: string;
      status: AgentUserStatus;
      availability?: string;
      creator: AgentProfileCreator | null;
    };

/** Response for `GET /api/agent/v1/profile[?target=<name>]`. */
export type AgentProfileShowResponse = {
  ok: true;
  profile: AgentProfileView;
};

/** Request body for `POST /api/agent/v1/profile`. Applies to the calling Agent only; the
 * Username (`name`) is fixed at creation and is never accepted here. */
export type AgentProfileUpdateRequest = {
  displayName?: string;
  description?: string;
};

/** Response for `POST /api/agent/v1/profile`: the calling Agent's updated profile. */
export type AgentProfileUpdateResponse = {
  ok: true;
  profile: AgentProfileView & { kind: "agent" };
};

/** `agent_not_visible`: see `user-info.ts`'s matching code — the same distinction
 * applies to `profile show`'s target resolution. */
export const AGENT_PROFILE_ERROR_CODES = [
  "user_not_found",
  "profile_invalid",
  "agent_not_visible",
] as const;
export type AgentProfileErrorCode = (typeof AGENT_PROFILE_ERROR_CODES)[number];

export type AgentProfileErrorResponse = {
  ok: false;
  errorCode: AgentProfileErrorCode;
  error: string;
};

const profileErrorResponseSchema = z.object({
  ok: z.literal(false),
  errorCode: z.enum(AGENT_PROFILE_ERROR_CODES),
  error: z.string(),
});

const userStatusSchema = z.enum(["online", "offline", "unknown"]);

const createdAgentSchema = z.looseObject({
  name: z.string(),
  displayName: z.string(),
  status: userStatusSchema,
});

const creatorSchema = z.looseObject({
  name: z.string(),
  displayName: z.string(),
});

const profileBaseShape = {
  id: z.string(),
  name: z.string(),
  displayName: z.string(),
  description: z.string(),
  role: z.string().nullable(),
  isSelf: z.boolean(),
};

const profileViewSchema = z.discriminatedUnion("kind", [
  z.looseObject({
    ...profileBaseShape,
    kind: z.literal("human"),
    createdAgents: z.array(createdAgentSchema),
  }),
  z.looseObject({
    ...profileBaseShape,
    kind: z.literal("agent"),
    status: userStatusSchema,
    creator: creatorSchema.nullable(),
  }),
]);

const profileShowResponseSchema = z.object({
  ok: z.literal(true),
  profile: profileViewSchema,
});

export function decodeAgentProfileErrorResponse(
  value: unknown,
): AgentProfileErrorResponse | undefined {
  const parsed = profileErrorResponseSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function decodeAgentProfileShowResponse(value: unknown): AgentProfileShowResponse {
  const parsed = profileShowResponseSchema.safeParse(value);
  if (!parsed.success) throw new Error("invalid Agent profile show response");
  return parsed.data as AgentProfileShowResponse;
}

export function decodeAgentProfileUpdateResponse(value: unknown): AgentProfileUpdateResponse {
  const decoded = decodeAgentProfileShowResponse(value);
  if (decoded.profile.kind !== "agent")
    throw new Error("invalid Agent profile update response: expected an agent profile");
  return { ok: true, profile: decoded.profile };
}
