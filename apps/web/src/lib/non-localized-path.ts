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
