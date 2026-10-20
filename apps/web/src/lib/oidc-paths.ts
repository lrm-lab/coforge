/** Login with CoForge's endpoints, under the issuer's origin (`<origin>/oidc`). The route files
 * name them literally (`routes/oidc.auth.tsx`, `routes/oidc.token.ts`, `routes/oidc.me.ts`), as
 * TanStack's file routes must. */
export const AUTHORIZATION_ENDPOINT_PATH = "/oidc/auth";
export const TOKEN_ENDPOINT_PATH = "/oidc/token";
/** The UserInfo endpoint (OIDC Core §5.3), which is also the access token's audience. */
export const USERINFO_ENDPOINT_PATH = "/oidc/me";
