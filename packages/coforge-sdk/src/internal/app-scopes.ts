/**
 * The Login with CoForge scopes an app may allow, in canonical order. A manifest action's
 * `required_scopes` and an Agent app token's `scope` draw from this vocabulary.
 */
export const APP_SCOPES = ["openid", "profile", "identity", "email"] as const;
export type AppScope = (typeof APP_SCOPES)[number];

/** The scopes every app has: signing a person in, their name, and who they are in the Workspace. */
export const APP_FIXED_SCOPES = [
  "openid",
  "profile",
  "identity",
] as const satisfies readonly AppScope[];
