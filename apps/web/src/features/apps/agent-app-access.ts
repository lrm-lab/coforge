import { APP_FIXED_SCOPES, APP_SCOPES } from "./app-registration";

/**
 * An Agent's access to the apps installed in its Workspace, as both the browser and the server
 * (`server/app-agent-access/`) name it. Pure and client-safe.
 */

/** How a grant was given: by a person, on the Agent's first use of the app, or by a person's
 * approval of the Agent's request. */
export type AgentAppGrantSource = "person" | "automatic" | "approval";

/**
 * The scopes a grant carries for `requested`: the fixed ones (`openid`, `profile`, `identity`) and
 * the requested ones, in `APP_SCOPES` order; `undefined` when one is not in `allowed`, the app's
 * allowed scopes.
 */
export function agentGrantScopes(
  requested: readonly string[],
  allowed: readonly string[],
): string[] | undefined {
  if (requested.some((scope) => !allowed.includes(scope))) return undefined;
  return allowedGrantScopes(requested, allowed);
}

/** The fixed scopes and those of `scopes` that `allowed` still has, in `APP_SCOPES` order. */
export function allowedGrantScopes(
  scopes: readonly string[],
  allowed: readonly string[],
): string[] {
  const wanted = new Set<string>([
    ...APP_FIXED_SCOPES,
    ...scopes.filter((scope) => allowed.includes(scope)),
  ]);
  return APP_SCOPES.filter((scope) => wanted.has(scope));
}

/** Whether a grant of `granted` scopes covers every one of `requested`. */
export function grantCovers(granted: readonly string[], requested: readonly string[]): boolean {
  return requested.every((scope) => granted.includes(scope));
}
