import { isValidWorkspaceSlug } from "#src/features/workspaces/workspace-slug";

const BASE = "http://coforge.invalid";

/**
 * A message-body href that names a Workspace page (`/w/<slug>/…`).
 * Returns the path URL resolution actually names, or undefined when the link
 * must stay an external tab: another origin, a scheme, a relative path, or a
 * path that resolves outside `/w/<slug>`.
 */
export function internalAppHref(href: string | undefined): string | undefined {
  if (typeof href !== "string") return undefined;
  if (/[\u0000-\u001F\u007F\\]/.test(href)) return undefined;
  const trimmed = href.trim();
  if (!trimmed.startsWith("/") || trimmed.startsWith("//")) return undefined;
  let url: URL;
  try {
    url = new URL(trimmed, BASE);
  } catch {
    return undefined;
  }
  if (url.origin !== BASE) return undefined;
  const slug = /^\/w\/([^/]+)(\/.*)?$/.exec(url.pathname)?.[1];
  if (!slug || !isValidWorkspaceSlug(slug)) return undefined;
  return url.pathname + url.search + url.hash;
}

/** A plain left click follows an in-app link here. A modified or already-handled click does not. */
export function followInternalLinkClick(event: {
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  defaultPrevented: boolean;
}): boolean {
  if (event.defaultPrevented) return false;
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
    return false;
  }
  return true;
}
