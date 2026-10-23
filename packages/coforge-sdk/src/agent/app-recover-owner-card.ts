import { z } from "zod";

import { draftHintSchema } from "./action-card-draft-hint";

/**
 * The `app:recover_owner` card (`coforge app prepare recover-owner`): an Agent asks a Workspace
 * owner or admin to make another Agent of the Workspace the owner Agent of an app that has none
 * that is alive (the owner was archived or deleted). Only a Workspace owner or admin commits it,
 * and only while the app still has no live owner Agent.
 */
export const APP_RECOVER_OWNER_CARD_KIND = "app:recover_owner";

export const appRecoverOwnerActionSchema = z.strictObject({
  type: z.literal(APP_RECOVER_OWNER_CARD_KIND),
  /** The app's client key. */
  clientKey: z.string().trim().min(1).max(64),
  /** The Agent that becomes the owner Agent: a name (`name` or `@name`) or an id. */
  toAgent: z.string().trim().min(1).max(120),
  draftHint: draftHintSchema,
});
export type AppRecoverOwnerAction = z.infer<typeof appRecoverOwnerActionSchema>;

/** The stored payload: the app and the Agent as they were when the card was prepared. */
export type ResolvedAppRecoverOwnerPayload = {
  type: typeof APP_RECOVER_OWNER_CARD_KIND;
  clientKey: string;
  appName: string;
  toAgentId: string;
  toAgentName: string;
};
