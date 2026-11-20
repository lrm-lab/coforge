import type { CommentAnchor } from "./artifact-comment-inputs";
import { ELEMENT_LABEL_MAX, ELEMENT_SELECTOR_MAX } from "./artifact-page-annotations";

export type InlineElementRef = {
  kind: "element";
  tag: string;
  selector: string;
  quote?: string;
};

export type InlineSegment = { kind: "text"; text: string } | InlineElementRef;

const INLINE_REF_PATTERN = /\{\{<([a-zA-Z][a-zA-Z0-9:-]*)> ([^}\n]+)\}\}/g;
const TAG_TOKEN = /^[a-zA-Z][a-zA-Z0-9:-]*/;

function sanitizeTag(raw: string): string {
  const matched = raw.trim().match(TAG_TOKEN)?.[0];
  return matched ? matched.toLowerCase() : "el";
}

function sanitizeSelector(raw: string): string {
  return raw
    .replace(/[\r\n]+/g, " ")
    .replace(/\}\}/g, "")
    .replace(/[{}]/g, "")
    .trim()
    .slice(0, ELEMENT_SELECTOR_MAX);
}

export function extractElementTag(nameOrSelector: string): string {
  const tail = nameOrSelector.split(">").at(-1)?.trim() ?? "";
  const head = tail.split(/[\s#.[:]/, 1)[0] ?? "";
  return sanitizeTag(head);
}

export function encodeInlineElementRef(ref: { tag: string; selector: string }): string {
  const tag = sanitizeTag(ref.tag);
  const selector = sanitizeSelector(ref.selector);
  return selector ? `{{<${tag}> ${selector}}}` : `<${tag}>`;
}

export function hasInlineRefs(body: string): boolean {
  INLINE_REF_PATTERN.lastIndex = 0;
  return INLINE_REF_PATTERN.test(body);
}

export function parseInlineRefs(body: string): InlineSegment[] {
  if (!body) return [];
  INLINE_REF_PATTERN.lastIndex = 0;
  const segments: InlineSegment[] = [];
  let cursor = 0;
  for (const match of body.matchAll(INLINE_REF_PATTERN)) {
    const start = match.index ?? 0;
    if (start > cursor) segments.push({ kind: "text", text: body.slice(cursor, start) });
    const tag = sanitizeTag(match[1] ?? "");
    const selector = (match[2] ?? "").trim();
    if (selector) segments.push({ kind: "element", tag, selector });
    else segments.push({ kind: "text", text: match[0] });
    cursor = start + match[0].length;
  }
  if (cursor < body.length) segments.push({ kind: "text", text: body.slice(cursor) });
  return segments;
}

export function serializeInlineSegments(segments: readonly InlineSegment[]): string {
  return segments
    .map((segment) => (segment.kind === "element" ? encodeInlineElementRef(segment) : segment.text))
    .join("")
    .trim();
}

export function firstElementAnchorFromSegments(
  segments: readonly InlineSegment[],
): CommentAnchor | null {
  const first = segments.find((segment): segment is InlineElementRef => segment.kind === "element");
  if (!first) return null;
  const quote = (first.quote?.trim() || `<${first.tag}>`).slice(0, ELEMENT_LABEL_MAX);
  return {
    type: "element",
    data: {
      selector: first.selector.slice(0, ELEMENT_SELECTOR_MAX),
      quote,
    },
  };
}

export function elementAnchorsFromSegments(segments: readonly InlineSegment[]): CommentAnchor[] {
  const seen = new Set<string>();
  const anchors: CommentAnchor[] = [];
  for (const segment of segments) {
    if (segment.kind !== "element" || seen.has(segment.selector)) continue;
    seen.add(segment.selector);
    anchors.push({
      type: "element",
      data: {
        selector: segment.selector.slice(0, ELEMENT_SELECTOR_MAX),
        quote: (segment.quote?.trim() || `<${segment.tag}>`).slice(0, ELEMENT_LABEL_MAX),
      },
    });
  }
  return anchors;
}

export function segmentsFromDraft(draft: {
  body: string;
  anchor: CommentAnchor | null;
}): InlineSegment[] {
  if (hasInlineRefs(draft.body)) return parseInlineRefs(draft.body);
  if (draft.anchor?.type === "element") {
    const selector =
      typeof draft.anchor.data.selector === "string" ? draft.anchor.data.selector : "";
    const quote = typeof draft.anchor.data.quote === "string" ? draft.anchor.data.quote : undefined;
    if (selector) {
      const chip: InlineElementRef = {
        kind: "element",
        tag: extractElementTag(selector),
        selector,
        ...(quote ? { quote } : {}),
      };
      return draft.body ? [chip, { kind: "text", text: ` ${draft.body}` }] : [chip];
    }
  }
  return draft.body ? [{ kind: "text", text: draft.body }] : [];
}
