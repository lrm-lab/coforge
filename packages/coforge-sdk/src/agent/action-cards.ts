import { z } from "zod";

import { AGENT_NAME_MAX_LENGTH, AGENT_NAME_PATTERN } from "#src/internal/agent-name";
import { CHANNEL_NAME_PATTERN } from "#src/internal/channel-references";
import { draftHintSchema } from "./action-card-draft-hint";
import {
  APP_REGISTER_CARD_KIND,
  appRegisterActionSchema,
  validateAppRegisterAction,
  type ResolvedAppRegisterPayload,
} from "./app-register-card";

import {
  appRecoverOwnerActionSchema,
  type ResolvedAppRecoverOwnerPayload,
} from "./app-recover-owner-card";

export * from "./app-register-card";
export * from "./app-recover-owner-card";

/**
 * Agent-prepared action card contract (`coforge action prepare`). An Agent
 * prepares exactly six card kinds: `channel:create`, `agent:create`,
 * `channel:add_member`, `app:register`, `app:recover_owner`, `page:fill`. A seventh, `app:grant_agent`, only the server posts: it
 * asks a person to approve an Agent's use of an app (`coforge app token`).
 *
 * An Agent identifies humans, Agents, channels, and computers by handle
 * (`@alice`, `alice`, `#general`, `general`) or UUID. `ActionCards.prepare`
 * (see `apps/web/src/server/conversations/action-cards.server.ts`) resolves
 * every handle to a UUID before persisting the card; Agents never see or
 * write UUIDs in an action card payload.
 */

/** A handle (`@alice` / `alice` / `#general`) or a UUID; resolved server-side at prepare time. */
export const idOrHandleSchema = z.string().trim().min(1).max(120);

export { draftHintSchema };

/** Strips one leading `#` before validating against the channel name rule. */
const channelNameSchema = z
  .string()
  .trim()
  .transform((value) => (value.startsWith("#") ? value.slice(1) : value))
  .pipe(z.string().min(1).max(32).regex(CHANNEL_NAME_PATTERN));

export const channelCreateActionSchema = z.object({
  type: z.literal("channel:create"),
  name: channelNameSchema,
  visibility: z.enum(["public", "private"]).default("public"),
  description: z.string().trim().max(500).optional(),
  /**
   * Humans to add to the channel on creation. Each entry is a handle
   * (`@alice` or bare `alice`) or a UUID; resolved at prepare time.
   */
  initialHumans: z.array(idOrHandleSchema).max(64).optional(),
  /**
   * Agents to add to the channel on creation. Each entry is a handle
   * (`@scout` or bare `scout`) or a UUID; resolved at prepare time.
   */
  initialAgents: z.array(idOrHandleSchema).max(64).optional(),
  draftHint: draftHintSchema,
});
export type ChannelCreateAction = z.infer<typeof channelCreateActionSchema>;

export const agentCreateActionSchema = z.object({
  type: z.literal("agent:create"),
  name: z.string().trim().min(1).max(AGENT_NAME_MAX_LENGTH).regex(AGENT_NAME_PATTERN),
  description: z.string().trim().max(500).optional(),
  /**
   * Optional computer placement contract. Runtime / model / reasoning effort
   * remain human-picked technical fields and are never part of this contract.
   * `suggestedComputer` preselects the create dialog; `requiredComputer`
   * prevents silent fallback to any other computer. At most one may be set
   * (see `validateActionCardAction`).
   */
  suggestedComputer: idOrHandleSchema.optional(),
  requiredComputer: idOrHandleSchema.optional(),
  draftHint: draftHintSchema,
});
export type AgentCreateAction = z.infer<typeof agentCreateActionSchema>;

export const channelAddMemberActionSchema = z.object({
  type: z.literal("channel:add_member"),
  /** Target channel: handle (`#general` or bare `general`) or UUID; resolved at prepare time. */
  channel: idOrHandleSchema,
  /** Same resolution rule as `channelCreateActionSchema.initialHumans`. */
  humans: z.array(idOrHandleSchema).max(64).optional(),
  /** Same resolution rule as `channelCreateActionSchema.initialAgents`. */
  agents: z.array(idOrHandleSchema).max(64).optional(),
  draftHint: draftHintSchema,
});
export type ChannelAddMemberAction = z.infer<typeof channelAddMemberActionSchema>;

const pageFillSelectorSchema = z
  .string()
  .trim()
  .min(1)
  .max(300)
  .refine((value) => !/[\u0000-\u001F\u007F]/.test(value), "control characters");

const pageFillFieldSchema = z.object({
  id: z
    .string()
    .trim()
    .regex(/^[a-z][a-z0-9_]{0,31}$/),
  label: z.string().trim().min(1).max(80),
  input: z.enum(["text", "password"]),
  selector: pageFillSelectorSchema,
});

/**
 * Ask a person to type into a page on this Agent's computer. The card names the
 * fields only. Values are typed later and are not part of this action.
 */
export const pageFillActionSchema = z.object({
  type: z.literal("page:fill"),
  prompt: z.string().trim().min(1).max(200).optional(),
  fields: z.array(pageFillFieldSchema).min(1).max(8),
  draftHint: draftHintSchema,
});
export type PageFillAction = z.infer<typeof pageFillActionSchema>;

export const actionCardActionSchema = z.discriminatedUnion("type", [
  channelCreateActionSchema,
  agentCreateActionSchema,
  channelAddMemberActionSchema,
  appRegisterActionSchema,
  appRecoverOwnerActionSchema,
  pageFillActionSchema,
]);
export type ActionCardAction = z.infer<typeof actionCardActionSchema>;
/** The server-posted approval card for an Agent's use of an app; never an Agent's action. */
export const APP_GRANT_AGENT_CARD_KIND = "app:grant_agent";
export type ActionCardKind = ActionCardAction["type"] | typeof APP_GRANT_AGENT_CARD_KIND;

/**
 * Cross-field rules the schema alone cannot express. Returns a human-readable
 * message, or `null` when the action is valid.
 */
export function validateActionCardAction(action: ActionCardAction): string | null {
  if (action.type === "agent:create") {
    if (action.suggestedComputer && action.requiredComputer)
      return "agent:create must include only one of suggestedComputer or requiredComputer";
  }
  if (action.type === APP_REGISTER_CARD_KIND) return validateAppRegisterAction(action);
  if (action.type === "channel:add_member") {
    const total = (action.humans?.length ?? 0) + (action.agents?.length ?? 0);
    if (total === 0) return "channel:add_member must include at least one human or agent";
  }
  if (action.type === "page:fill") {
    const ids = action.fields.map((field) => field.id);
    if (new Set(ids).size !== ids.length) return "page:fill field ids must be unique";
  }
  return null;
}

/** The resolved, UUID-only payload stored server-side on the `ActionCard` row (`payload` column). */
export type ResolvedChannelCreatePayload = {
  type: "channel:create";
  name: string;
  visibility: "public" | "private";
  description?: string;
  initialHumanIds?: string[];
  initialAgentIds?: string[];
};
export type ResolvedAgentCreatePayload = {
  type: "agent:create";
  name: string;
  description?: string;
  suggestedComputerId?: string;
  requiredComputerId?: string;
};
export type ResolvedChannelAddMemberPayload = {
  type: "channel:add_member";
  channelId: string;
  humanIds?: string[];
  agentIds?: string[];
};
/** Approving it approves the Agent's waiting request `requestId` for the app `appKey`, granting
 * `scopes`; denying it denies the request. */
export type ResolvedAppGrantAgentPayload = {
  type: typeof APP_GRANT_AGENT_CARD_KIND;
  requestId: string;
  agentId: string;
  appKey: string;
  appName: string;
  scopes: string[];
};
/** Selectors stay here so the page can be filled. Values never do. */
export type ResolvedPageFillPayload = {
  type: "page:fill";
  prompt?: string;
  agentId: string;
  fields: { id: string; label: string; input: "text" | "password"; selector: string }[];
};
export type ResolvedActionCardPayload =
  | ResolvedChannelCreatePayload
  | ResolvedAgentCreatePayload
  | ResolvedChannelAddMemberPayload
  | ResolvedAppGrantAgentPayload
  | ResolvedAppRegisterPayload
  | ResolvedAppRecoverOwnerPayload
  | ResolvedPageFillPayload;

/** `POST /api/agent/v1/actions/prepare` request body. */
export type AgentActionPrepareRequest = {
  target: string;
  action: ActionCardAction;
};

/** `POST /api/agent/v1/actions/prepare` success response. */
export type AgentActionPrepareResponse = {
  messageId: string;
  metadata: { kind: "action-card" };
};
