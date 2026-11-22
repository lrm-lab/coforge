import { AUTHORIZATION_ENDPOINT_PATH } from "./oidc-paths.ts";

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

export const NON_LOCALIZED_PAGES = ["/oauth/verify", AUTHORIZATION_ENDPOINT_PATH] as const;

export function isRawHttpPath(pathname: string): boolean {
  return (
    isNonLocalizedPath(pathname) && !(NON_LOCALIZED_PAGES as readonly string[]).includes(pathname)
  );
}
