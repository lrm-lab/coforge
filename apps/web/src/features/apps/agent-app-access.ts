import { APP_FIXED_SCOPES, APP_IDENTITY_SCOPES } from "./app-registration";

/**
 * An Agent's access to the apps installed in its Workspace, as both the browser and the server
 * (`server/app-agent-access/`) name it. Pure and client-safe.
 */

/** How a grant was given: by a person, on the Agent's first use of the app, or by a person's
 * approval of the Agent's request. */
export type AgentAppGrantSource = "person" | "automatic" | "approval";

/** The `errorId` of the CONFLICT for an approval of a request whose scopes moved on since the card
 * that asked for it showed them. */
export const APP_GRANT_REQUEST_CHANGED = "app-grant-request-changed";

/** `scopes` with the fixed scopes (`openid`, `profile`, `identity`) always present, in
 * `APP_SCOPES` order. */
export function withFixedScopes(scopes: readonly string[]): string[] {
  return allowedGrantScopes(scopes, scopes);
}

const IDENTITY_SCOPE_SET = new Set<string>(APP_IDENTITY_SCOPES);

export function agentGrantScopes(
  requested: readonly string[],
  allowed: readonly string[],
): string[] | undefined {
  const allowedSet = new Set(allowed);
  if (requested.some((scope) => !allowedSet.has(scope) || !IDENTITY_SCOPE_SET.has(scope)))
    return undefined;
  return allowedGrantScopes(requested, allowed);
}

export function allowedGrantScopes(
  scopes: readonly string[],
  allowed: readonly string[],
): string[] {
  const allowedSet = new Set(allowed);
  const wanted = new Set<string>([
    ...APP_FIXED_SCOPES,
    ...scopes.filter((scope) => allowedSet.has(scope)),
  ]);
  return APP_IDENTITY_SCOPES.filter((scope) => wanted.has(scope));
}

export function grantCovers(granted: readonly string[], requested: readonly string[]): boolean {
  const grantedSet = new Set(granted);
  return requested.every((scope) => grantedSet.has(scope));
}
