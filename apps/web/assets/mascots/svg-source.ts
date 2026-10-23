import { readFileSync } from "node:fs";

/** One drawn element of a source mascot SVG, with `<use>` already resolved to its path. */
export interface SvgElement {
  tag: "path" | "circle" | "ellipse" | "rect";
  attrs: Record<string, string>;
}

function attrsOf(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const m of source.matchAll(/([\w:-]+)="([^"]*)"/g)) attrs[m[1] as string] = m[2] as string;
  return attrs;
}

/**
 * The visible elements of a Figma-exported mascot SVG, in paint order (bottom first). The clip
 * masks, the outline-mask rectangles and `<defs>` are not drawn elements, so they are skipped.
 * The outer white outline (`mask="url(#stroke…)"` path) is skipped too: the Rive scene draws its
 * own outline.
 */
export function drawnElements(file: string): SvgElement[] {
  const svg = readFileSync(file, "utf8");
  const defs = new Map<string, string>();
  const defsBlock = svg.match(/<defs>([\s\S]*?)<\/defs>/)?.[1] ?? "";
  for (const m of defsBlock.matchAll(/<path\b([^>]*)\/>/g)) {
    const a = attrsOf(m[1] as string);
    if (a.id && a.d) defs.set(a.id, a.d);
  }
  // Drop <defs> and every <mask>…</mask> so only the painted tree remains.
  const body = svg
    .replace(/<defs>[\s\S]*?<\/defs>/, "")
    .replace(/<mask\b[\s\S]*?<\/mask>/g, (block) => (block.includes("<g") ? block : ""));
  const out: SvgElement[] = [];
  for (const m of body.matchAll(/<(path|circle|ellipse|rect|use)\b([^>]*)\/?>/g)) {
    const tag = m[1] as string;
    const attrs = attrsOf(m[2] as string);
    if (tag === "use") {
      const d = defs.get((attrs["xlink:href"] ?? "").replace("#", ""));
      if (d) out.push({ tag: "path", attrs: { d, fill: attrs.fill ?? "none" } });
    } else if (attrs.mask?.startsWith("url(#stroke")) {
      continue; // the outer outline ring
    } else {
      out.push({ tag: tag as SvgElement["tag"], attrs });
    }
  }
  return out;
}
