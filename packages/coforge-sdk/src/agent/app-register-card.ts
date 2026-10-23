import { z } from "zod";

import { draftHintSchema } from "./action-card-draft-hint";

/**
 * The `app:register` card (`coforge app prepare register`): an Agent asks a Workspace owner or
 * admin to register an app, with the Agent as its owner Agent. Every field is shown on the card;
 * the client secret is never part of it. The server checks each value against the app registry's
 * input rules when the card is prepared (`apps/web/src/features/apps/app-registration.ts`), so
 * the schema here only bounds the shapes.
 */
export const APP_REGISTER_CARD_KIND = "app:register";

export const appRegisterActionSchema = z.strictObject({
  type: z.literal(APP_REGISTER_CARD_KIND),
  name: z.string().trim().min(1).max(200),
  /** The app's client key (`client_id`); absent: made from the name when the card is committed. */
  clientKey: z.string().trim().max(64).optional(),
  redirectUrls: z.array(z.string().trim().min(1).max(2048)).max(10).default([]),
  homepageUrl: z.string().trim().max(2048).optional(),
  description: z.string().trim().max(2000).optional(),
  whenToUse: z.string().trim().max(500).optional(),
  category: z.string().trim().max(40).optional(),
  agentManifestUrl: z.string().trim().max(2048).optional(),
  /** Login scopes beyond the fixed ones (`openid`, `profile`, `identity`). */
  scopes: z.array(z.string().trim().min(1).max(32)).max(8).default([]),
  draftHint: draftHintSchema,
});
export type AppRegisterAction = z.infer<typeof appRegisterActionSchema>;

/** Cross-field rules the schema cannot express; `null` when the action is valid. */
export function validateAppRegisterAction(action: AppRegisterAction): string | null {
  if (new Set(action.redirectUrls).size !== action.redirectUrls.length)
    return "app:register must not repeat a redirect URL";
  if (new Set(action.scopes).size !== action.scopes.length)
    return "app:register must not repeat a scope";
  return null;
}

/** The stored payload: the registration as the registry takes it, checked when prepared. An empty
 * `key` asks for a key made from the name on commit. */
export type ResolvedAppRegisterPayload = {
  type: typeof APP_REGISTER_CARD_KIND;
  key: string;
  name: string;
  description: string;
  whenToUse: string;
  homepageUrl: string | null;
  redirectUris: string[];
  category: string;
  allowedScopes: string[];
  agentManifestUrl: string | null;
};
