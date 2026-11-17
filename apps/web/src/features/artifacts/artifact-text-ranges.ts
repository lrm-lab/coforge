import { setCssHighlight } from "#src/lib/css-highlight";
import {
  COMMENT_DRAFT_HIGHLIGHT,
  NEUTRAL,
  type AnchorLocation,
  type SurfaceAdapter,
} from "./artifact-anchor-places";
import {
  findQuote,
  firstIndexWhere,
  joinPieces,
  quoteAnchor,
  type TextQuote,
} from "./artifact-text-anchor";

type Span = { node: Text; start: number; end: number };

export type TextIndex = {
  text: string;
  spans: readonly Span[];
  byNode: ReadonlyMap<Node, Span>;
};

const BLOCK_SELECTOR = "p,h1,h2,h3,h4,h5,h6,li,blockquote,pre,td,th,tr,div";
const SKIPPED_SELECTOR = ".katex-mathml,[data-anchor-chrome]";

export function buildTextIndex(root: Element): TextIndex {
  const nodes: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text;
    if (text.data !== "" && !text.parentElement?.closest(SKIPPED_SELECTOR)) nodes.push(text);
  }
  const { text, starts } = joinPieces(
    nodes.map((node) => [node.data, node.parentElement?.closest(BLOCK_SELECTOR)] as const),
  );
  const spans = nodes.map((node, at) => ({
    node,
    start: starts[at]!,
    end: starts[at]! + node.data.length,
  }));
  return { text, spans, byNode: new Map(spans.map((span) => [span.node, span])) };
}

function offsetOf(index: TextIndex, node: Node, offset: number): number {
  const span = node.nodeType === Node.TEXT_NODE ? index.byNode.get(node) : undefined;
  if (span) return span.start + offset;
  const probe = document.createRange();
  probe.setStart(node, offset);
  probe.collapse(true);
  const next =
    index.spans[firstIndexWhere(index.spans, (entry) => probe.comparePoint(entry.node, 0) >= 0)];
  return next ? next.start : index.text.length;
}

function locateTextQuote(index: TextIndex, anchor: TextQuote): AnchorLocation | null {
  const found = findQuote(index.text, anchor);
  if (!found) return null;
  const first = index.spans[firstIndexWhere(index.spans, (span) => span.end > found.start)];
  const last = index.spans[firstIndexWhere(index.spans, (span) => span.end >= found.end)];
  if (!first || !last) return null;
  const range = document.createRange();
  range.setStart(first.node, Math.max(0, found.start - first.start));
  range.setEnd(last.node, found.end - last.start);
  return { range, element: first.node.parentElement ?? document.body, order: found.start };
}

export const textAdapter: SurfaceAdapter<TextIndex, Range> = {
  build(root) {
    const index = buildTextIndex(root);
    return index.text === "" ? null : index;
  },
  locate(index, anchor) {
    const { data } = anchor;
    if (anchor.type !== "text" || typeof data.quote !== "string") return NEUTRAL;
    const location = locateTextQuote(index, {
      quote: data.quote,
      prefix: typeof data.prefix === "string" ? data.prefix : undefined,
      suffix: typeof data.suffix === "string" ? data.suffix : undefined,
    });
    return location ? { status: "found", location } : NEUTRAL;
  },
  fromSelection(index, range) {
    const quote = quoteAnchor(
      index.text,
      offsetOf(index, range.startContainer, range.startOffset),
      offsetOf(index, range.endContainer, range.endOffset),
    );
    if (!quote) return null;
    const kept = range.cloneRange();
    return {
      anchor: { type: "text", data: quote },
      target: {
        rect: range.getBoundingClientRect(),
        highlight: (on) => setCssHighlight(COMMENT_DRAFT_HIGHLIGHT, on ? [kept] : []),
      },
    };
  },
};
