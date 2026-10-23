/**
 * The Login with CoForge scopes an app may allow, in canonical order. A manifest action's
 * `required_scopes` and an Agent app token's `scope` draw from this vocabulary.
 */
export const APP_IDENTITY_SCOPES = ["openid", "profile", "identity", "email"] as const;

/**
 * The optional scopes that let an installed app send an event or a notification to one selected
 * Agent (Agent inbound). They are declared at registration like `email`, but are never requested
 * at the authorization endpoint and never carried by an Agent's app token: an app asks for them
 * with an Agent request and gets a token bound to one Agent.
 */
export const APP_AGENT_INBOUND_SCOPES = ["agent:event:write", "agent:notification:write"] as const;

/** Every scope an app may declare in its registration, in canonical order. */
export const APP_SCOPES = [...APP_IDENTITY_SCOPES, ...APP_AGENT_INBOUND_SCOPES] as const;
export type AppScope = (typeof APP_SCOPES)[number];

/** The scopes every app has: signing a person in, their name, and who they are in the Workspace. */
export const APP_FIXED_SCOPES = [
  "openid",
  "profile",
  "identity",
] as const satisfies readonly AppScope[];
