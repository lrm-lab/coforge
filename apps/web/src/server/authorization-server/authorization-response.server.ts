/** What an authorization response carries besides the issuer: a code, or an error. */
export type AuthorizationResponseParams =
  | { code: string; state?: string }
  | { error: string; error_description: string; state?: string };

/**
 * The URL that sends the browser back to the app: its registered redirect URI with the response
 * parameters and `iss` (RFC 9207 §2) added to the query. The redirect URI's own query is kept as
 * registered (RFC 6749 §3.1.2), so its parameters are appended to the string rather than
 * re-serialized through `URL`, which could re-encode them.
 */
export function authorizationResponseUrl(
  redirectUri: string,
  issuer: string,
  params: AuthorizationResponseParams,
): string {
  const added = new URLSearchParams();
  for (const [name, value] of Object.entries(params)) if (value) added.append(name, value);
  added.append("iss", issuer);
  const separator = !redirectUri.includes("?") ? "?" : redirectUri.endsWith("?") ? "" : "&";
  return `${redirectUri}${separator}${added.toString()}`;
}
