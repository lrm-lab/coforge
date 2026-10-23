/** Pure decisions behind publish-docs-site.ts: object metadata, upload order, stale keys. */

const CONTENT_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  json: "application/json",
  xml: "application/xml",
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  woff2: "font/woff2",
  png: "image/png",
  svg: "image/svg+xml",
  ico: "image/x-icon",
};

export function extensionOf(key: string): string {
  const name = key.slice(key.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
}

export function contentTypeFor(key: string): string {
  return CONTENT_TYPES[extensionOf(key)] ?? "application/octet-stream";
}

/** `assets/**` is content-hashed, so a year and immutable; small images a day; everything else
 * (pages, llms.txt, schemas) is revalidated on every request. */
export function cacheControlFor(key: string): string {
  if (key.startsWith("assets/")) return "public, max-age=31536000, immutable";
  if (["png", "svg", "ico"].includes(extensionOf(key))) return "public, max-age=86400";
  return "no-cache";
}

/** Upload order: `assets/**` first, other non-HTML next, HTML last; alphabetical inside a tier. */
export function uploadOrder(keys: readonly string[]): string[] {
  const tier = (key: string): number =>
    key.startsWith("assets/") ? 0 : extensionOf(key) === "html" ? 2 : 1;
  return [...keys].sort((a, b) => tier(a) - tier(b) || (a < b ? -1 : a > b ? 1 : 0));
}

/** Bucket objects the dist no longer carries. */
export function staleKeys(existing: readonly string[], distKeys: readonly string[]): string[] {
  const keep = new Set(distKeys);
  return existing.filter((key) => !keep.has(key));
}

/** A dist that is empty or lacks index.html or llms.txt is a failed build, never a reason to delete anything. */
export function assertDistUsable(distKeys: readonly string[]): void {
  if (distKeys.length === 0) throw new Error("dist is empty; refusing to publish or delete");
  for (const required of ["index.html", "llms.txt"])
    if (!distKeys.includes(required))
      throw new Error(`dist has no ${required}; refusing to publish or delete`);
}
