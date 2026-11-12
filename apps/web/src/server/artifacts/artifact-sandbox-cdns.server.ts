/**
 * The public hosts a web page may load code, styles, fonts and images from, so it can use a
 * library or a web font without shipping it. They are named in its CSP and nowhere else: the
 * page still reaches nothing over the network (`connect-src 'none'`), and a CDN-served script
 * runs in the page's own opaque origin like the page's inline ones.
 *
 * - Package CDNs (npm and GitHub mirrors, a CSS framework's and a charting library's own host):
 *   scripts, styles, and the fonts and images those packages bring.
 * - The font service's two hosts: its stylesheet (`fonts.googleapis.com`, styles only) and the
 *   font files that stylesheet names (`fonts.gstatic.com`, fonts only).
 */
export const SANDBOX_PUBLIC_CDNS = [
  "https://cdnjs.cloudflare.com",
  "https://cdn.jsdelivr.net",
  "https://unpkg.com",
  "https://esm.sh",
  "https://cdn.tailwindcss.com",
  "https://code.jquery.com",
  "https://cdn.plot.ly",
] as const;

const FONT_STYLES = "https://fonts.googleapis.com";
const FONT_FILES = "https://fonts.gstatic.com";

/** A page's CSP directives with the public hosts added to the ones that load from them. */
export function withPublicCdns(directives: readonly string[]): string[] {
  const extra: Record<string, readonly string[]> = {
    "script-src": SANDBOX_PUBLIC_CDNS,
    "style-src": [...SANDBOX_PUBLIC_CDNS, FONT_STYLES],
    "font-src": [...SANDBOX_PUBLIC_CDNS, FONT_FILES],
    "img-src": SANDBOX_PUBLIC_CDNS,
  };
  return directives.map((directive) => {
    const added = extra[directive.slice(0, directive.indexOf(" "))];
    return added ? `${directive} ${added.join(" ")}` : directive;
  });
}
