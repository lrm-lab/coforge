export function supportsCssHighlights(): boolean {
  return typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight !== "undefined";
}

export function setCssHighlight(name: string, ranges: readonly Range[]) {
  if (!supportsCssHighlights()) return;
  if (ranges.length > 0) CSS.highlights.set(name, new Highlight(...ranges));
  else CSS.highlights.delete(name);
}
