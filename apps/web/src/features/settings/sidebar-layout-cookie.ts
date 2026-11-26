import { browserCookie, cookiePairs } from "#src/lib/browser-cookie";

export const SIDEBAR_LAYOUT_COOKIE = "coforge-sidebar-layout";
export const SIDEBAR_DEFAULT_REM = 15;
export const SIDEBAR_MIN_REM = 10;
export const SIDEBAR_MAX_REM = 20;

const SIDEBAR_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;
const PLAIN_NUMBER = /^\d+(\.\d+)?$/;

export type SidebarLayoutCookie = {
  expanded?: boolean;
  widthRem?: number;
};

export function clampSidebarWidthRem(rem: number): number {
  return Math.min(SIDEBAR_MAX_REM, Math.max(SIDEBAR_MIN_REM, rem));
}

export function parseSidebarWidthRem(raw: string | null | undefined): number | undefined {
  if (!raw || !PLAIN_NUMBER.test(raw)) return undefined;
  const parsed = Number(raw);
  const rem = parsed > 80 ? parsed / 16 : parsed;
  return clampSidebarWidthRem(rem);
}

export function parseSidebarLayoutCookie(cookieHeader: string | undefined): SidebarLayoutCookie {
  for (const [name, rawValue] of cookiePairs(cookieHeader)) {
    if (name !== SIDEBAR_LAYOUT_COOKIE) continue;
    let decoded: string;
    try {
      decoded = decodeURIComponent(rawValue);
    } catch {
      return {};
    }
    const [stateToken, widthToken] = decoded.split(":");
    const expanded = stateToken === "show" ? true : stateToken === "hide" ? false : undefined;
    const widthRem = parseSidebarWidthRem(widthToken);
    if (expanded === undefined && widthRem === undefined) return {};
    return {
      ...(expanded !== undefined ? { expanded } : {}),
      ...(widthRem !== undefined ? { widthRem } : {}),
    };
  }
  return {};
}

export function serializeSidebarLayoutCookie(
  layout: SidebarLayoutCookie,
  secure: boolean,
): string | null {
  const stateToken = layout.expanded === true ? "show" : layout.expanded === false ? "hide" : "";
  const widthToken =
    layout.widthRem !== undefined
      ? String(Math.round(clampSidebarWidthRem(layout.widthRem) * 1000) / 1000)
      : "";
  const value = widthToken ? `${stateToken}:${widthToken}` : stateToken;
  if (!value) return null;
  return browserCookie(SIDEBAR_LAYOUT_COOKIE, value, SIDEBAR_COOKIE_MAX_AGE, secure);
}

export function writeSidebarLayoutCookie(layout: SidebarLayoutCookie): void {
  if (typeof document === "undefined") return;
  const current = parseSidebarLayoutCookie(document.cookie);
  const next: SidebarLayoutCookie = {
    expanded: layout.expanded !== undefined ? layout.expanded : current.expanded,
    widthRem: layout.widthRem !== undefined ? layout.widthRem : current.widthRem,
  };
  const cookie = serializeSidebarLayoutCookie(
    next,
    typeof window !== "undefined" && window.location.protocol === "https:",
  );
  if (cookie) document.cookie = cookie;
}
