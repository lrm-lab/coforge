/** Every answer of `/oidc/auth`: the page asks for a decision, so no other site may frame it
 * (clickjacking, RFC 6749 §10.13); no cache may keep it or a redirect carrying a code; and its
 * query (state, PKCE challenge) never leaves in a Referer. */
export const AUTHORIZATION_PAGE_HEADERS = {
  "content-security-policy": "frame-ancestors 'none'",
  "x-frame-options": "DENY",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
} as const;
