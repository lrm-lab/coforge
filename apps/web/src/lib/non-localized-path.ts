import { AUTHORIZATION_ENDPOINT_PATH } from "./oidc-paths";

/** Paths that exist once, without a locale prefix: raw APIs, the device flow,
 * the CoForge OIDC issuer (`/oidc`), and discovery. */
export function isNonLocalizedPath(pathname: string): boolean {
  return (
    pathname === "/api" ||
    pathname.startsWith("/api/") ||
    pathname === "/oauth" ||
    pathname.startsWith("/oauth/") ||
    pathname === "/oidc" ||
    pathname.startsWith("/oidc/") ||
    pathname === "/.well-known" ||
    pathname.startsWith("/.well-known/")
  );
}

/** The pages among them. They render in the visitor's locale (Paraglide's `routeStrategies` in
 * `paraglide.config.ts`), still without a prefix. */
export const NON_LOCALIZED_PAGES = ["/oauth/verify", AUTHORIZATION_ENDPOINT_PATH] as const;

/** The rest of them, which answer raw HTTP and never pass through Paraglide. */
export function isRawHttpPath(pathname: string): boolean {
  return (
    isNonLocalizedPath(pathname) && !(NON_LOCALIZED_PAGES as readonly string[]).includes(pathname)
  );
}
