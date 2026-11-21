import { setCssHighlight } from "#src/lib/css-highlight";
import { firstIndexWhere } from "./artifact-text-anchor";
import { buildTextIndex } from "./artifact-text-ranges";

export const ARTIFACT_FIND_HIGHLIGHT = "artifact-find";
export const ARTIFACT_FIND_ACTIVE_HIGHLIGHT = "artifact-find-active";

export type TextMatch = { start: number; end: number };
export type TextSpanOffset = { start: number; end: number };
export type RangeEndpointPlan = {
  startIndex: number;
  startOffset: number;
  endIndex: number;
  endOffset: number;
};

export function findCaseInsensitiveMatches(text: string, query: string): TextMatch[] {
  if (query === "" || text === "") return [];
  const haystack = text.toLowerCase();
  const needle = query.toLowerCase();
  if (needle === "") return [];
  const matches: TextMatch[] = [];
  let cursor = 0;
  while (cursor <= haystack.length - needle.length) {
    const at = haystack.indexOf(needle, cursor);
    if (at === -1) break;
    const end = at + needle.length;
    if (end <= text.length) matches.push({ start: at, end });
    cursor = Math.max(at + 1, end);
  }
  return matches;
}

export function planMatchEndpoints(
  spans: readonly TextSpanOffset[],
  start: number,
  end: number,
): RangeEndpointPlan | null {
  if (spans.length === 0 || end <= start) return null;
  const startIndex = firstIndexWhere(spans, (span) => span.end > start);
  const endIndex = firstIndexWhere(spans, (span) => span.end >= end);
  const first = spans[startIndex];
  const last = spans[endIndex];
  if (!first || !last) return null;
  const startOffset = Math.max(0, Math.min(start - first.start, first.end - first.start));
  const endOffset = Math.max(0, Math.min(end - last.start, last.end - last.start));
  if (startIndex === endIndex && endOffset <= startOffset) return null;
  return { startIndex, startOffset, endIndex, endOffset };
}

export function stepMatchIndex(current: number, total: number, delta: number): number {
  if (total <= 0) return -1;
  if (current < 0 || current >= total) return delta < 0 ? total - 1 : 0;
  return (((current + delta) % total) + total) % total;
}

export function findDomMatches(root: Element, query: string): Range[] {
  if (query === "") return [];
  const index = buildTextIndex(root);
  const matches = findCaseInsensitiveMatches(index.text, query);
  const ranges: Range[] = [];
  for (const match of matches) {
    const plan = planMatchEndpoints(index.spans, match.start, match.end);
    if (!plan) continue;
    const startSpan = index.spans[plan.startIndex];
    const endSpan = index.spans[plan.endIndex];
    if (!startSpan || !endSpan) continue;
    const range = document.createRange();
    range.setStart(startSpan.node, plan.startOffset);
    range.setEnd(endSpan.node, plan.endOffset);
    ranges.push(range);
  }
  return ranges;
}

export function applyFindHighlights(ranges: readonly Range[], activeIndex: number) {
  setCssHighlight(ARTIFACT_FIND_HIGHLIGHT, ranges);
  const active = activeIndex >= 0 ? ranges[activeIndex] : undefined;
  setCssHighlight(ARTIFACT_FIND_ACTIVE_HIGHLIGHT, active ? [active] : []);
}

export function clearFindHighlights() {
  setCssHighlight(ARTIFACT_FIND_HIGHLIGHT, []);
  setCssHighlight(ARTIFACT_FIND_ACTIVE_HIGHLIGHT, []);
}

export function findScrollContainer(node: Element | null): HTMLElement | null {
  let current = node?.parentElement ?? null;
  while (current) {
    const style = window.getComputedStyle(current);
    if (style.overflowY === "auto" || style.overflowY === "scroll") return current;
    current = current.parentElement;
  }
  return null;
}

export function scrollRangeIntoView(range: Range, reducedMotion: boolean) {
  const behavior: ScrollBehavior = reducedMotion ? "auto" : "smooth";
  const anchor =
    range.startContainer instanceof Element
      ? range.startContainer
      : range.startContainer.parentElement;
  const scroller = findScrollContainer(anchor);
  const rect = range.getBoundingClientRect();
  if (scroller && (rect.height > 0 || rect.width > 0)) {
    const box = scroller.getBoundingClientRect();
    const targetTop =
      scroller.scrollTop + (rect.top - box.top) - Math.max(0, (box.height - rect.height) / 2);
    scroller.scrollTo({ top: Math.max(0, targetTop), behavior });
    return;
  }
  anchor?.scrollIntoView({ block: "center", behavior });
}
