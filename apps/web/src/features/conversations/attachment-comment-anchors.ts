import { z } from "zod";
import type { AttachmentPreviewKind } from "./attachment-preview-kind";

/**
 * Where in a file a comment points, in Raft 1.0.52's shapes. Shared by the Server Function that
 * validates a new comment and the browser that places, describes and jumps to it, so both read the
 * same definition. Whether a stored position can still be found is decided against the file's
 * current content when it is shown, never stored.
 */
const ANCHOR_TEXT_MAX = 200;
/** The selected text kept with an anchor; it confirms or recovers the position. */
export const ANCHOR_QUOTE_MAX = 500;
/** A line or row number past any file a 2 MB text preview can hold. */
const ANCHOR_INDEX_MAX = 10_000_000;
/** A pixel coordinate or size past any page a 2 MB HTML file lays out. */
const ANCHOR_PIXEL_MAX = 10_000_000;
/** How much of a region's quote its label shows, as in Raft. */
const REGION_LABEL_MAX = 36;

/** Text JSONB can store and display: no control characters and no half of a surrogate pair. */
const storable = (value: string) =>
  !/[\p{Cc}]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value);
const text = (max: number) => z.string().trim().max(max).refine(storable);
const quote = text(ANCHOR_QUOTE_MAX).min(1).optional();
const range = z
  .object({
    start: z.number().int().min(1).max(ANCHOR_INDEX_MAX),
    end: z.number().int().min(1).max(ANCHOR_INDEX_MAX),
    quote,
  })
  .strict()
  .refine((value) => value.start <= value.end);
const pixels = z.number().int().min(0).max(ANCHOR_PIXEL_MAX);

export const attachmentCommentAnchor = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("md-section"),
      data: z
        .object({
          // Empty for a heading of symbols only (`## 🚀`), whose GitHub slug is empty too.
          headingId: text(ANCHOR_TEXT_MAX),
          headingTitle: text(ANCHOR_TEXT_MAX).min(1),
          quote,
        })
        .strict(),
    })
    .strict(),
  z.object({ type: z.literal("lines"), data: range }).strict(),
  z.object({ type: z.literal("csv-rows"), data: range }).strict(),
  z
    .object({
      type: z.literal("html-region"),
      // Document coordinates (scroll included) of the box the reader drew; a click is 0 × 0.
      data: z
        .object({
          x: pixels,
          y: pixels,
          w: pixels,
          h: pixels,
          viewportWidth: pixels,
          documentWidth: pixels,
          documentHeight: pixels,
          quote,
        })
        .strict(),
    })
    .strict(),
]);
export type AttachmentCommentAnchor = z.infer<typeof attachmentCommentAnchor>;

/** A stored anchor as this build understands it, or `null` for one it cannot read. */
export function parseAttachmentCommentAnchor(value: unknown): AttachmentCommentAnchor | null {
  const parsed = attachmentCommentAnchor.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** The one anchor type a preview kind offers, or `null` for files only commented on whole. */
export function anchorTypeForPreview(
  kind: AttachmentPreviewKind | null,
): AttachmentCommentAnchor["type"] | null {
  if (kind === "markdown") return "md-section";
  if (kind === "text") return "lines";
  if (kind === "csv") return "csv-rows";
  if (kind === "html") return "html-region";
  return null;
}

/**
 * GitHub's heading slug: lower case, punctuation dropped, spaces to hyphens. Letters and digits in
 * any script stay, so a Chinese heading keeps its characters.
 */
export function headingSlug(title: string): string {
  return title
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "")
    .replace(/ /g, "-");
}

/** Each heading's id in document order; a repeated slug takes `-1`, `-2`, … as GitHub does. */
export function headingIds(titles: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return titles.map((title) => {
    const slug = headingSlug(title);
    const count = seen.get(slug) ?? 0;
    seen.set(slug, count + 1);
    return count === 0 ? slug : `${slug}-${count}`;
  });
}

/** The section anchor for the heading at `index`, its id and title cut to the stored bound. */
export function sectionAt(
  titles: readonly string[],
  index: number,
): { headingId: string; headingTitle: string } | null {
  if (index < 0 || index >= titles.length) return null;
  const headingTitle = storedText(titles[index]!, ANCHOR_TEXT_MAX);
  const headingId = storedText(headingIds(titles)[index]!, ANCHOR_TEXT_MAX);
  return headingTitle ? { headingId, headingTitle } : null;
}

/**
 * Finds section anchors among one file's headings (`titles`, in document order): by id first, then
 * by title when headings above it were added or removed, else `null` (the position is lost). Ids
 * and titles are worked out once, cut to the same bound a stored anchor was.
 */
export function sectionLocator(titles: readonly string[]) {
  const ids = headingIds(titles).map((id) => storedText(id, ANCHOR_TEXT_MAX));
  const bounded = titles.map((title) => storedText(title, ANCHOR_TEXT_MAX));
  return (anchor: { headingId: string; headingTitle: string }): number | null => {
    const byId = ids.indexOf(anchor.headingId);
    if (byId !== -1) return byId;
    const byTitle = bounded.indexOf(anchor.headingTitle);
    return byTitle === -1 ? null : byTitle;
  };
}

/**
 * Selected text as an anchor keeps it: whitespace folded, other control characters dropped, cut to
 * `max` without splitting a character in two.
 */
export function storedText(value: string, max: number): string {
  let kept = "";
  for (const char of value
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\p{Cc}/gu, "")) {
    if (kept.length + char.length > max) break;
    kept += char;
  }
  return kept;
}

/** Text with all whitespace removed: a quote matches however its lines or cells were joined. */
const compact = (value: string) => value.replace(/\s+/g, "");

/**
 * Finds line or row ranges in one file, given each line's (or row's) text. The stored range holds
 * while it fits and, when the anchor kept a quote, still contains it (whitespace aside: a
 * selection across table cells reads without the gaps between them); otherwise the quote is
 * searched for across the file, and a quote found nowhere, or a range past the end with no quote,
 * is lost (`null`). The folded file is built once, on the first search, and shared by every call.
 */
export function rangeLocator(texts: readonly string[]) {
  let index: { joined: string; starts: number[]; lines: number[] } | undefined;
  const folded = () => {
    if (index) return index;
    // Each non-empty line, compacted and joined, with where each one starts.
    const parts: string[] = [];
    const starts: number[] = [];
    const lines: number[] = [];
    let offset = 0;
    texts.forEach((text, i) => {
      const part = compact(text);
      if (!part) return;
      parts.push(part);
      starts.push(offset);
      lines.push(i + 1);
      offset += part.length;
    });
    return (index = { joined: parts.join(""), starts, lines });
  };
  const lineAt = (position: number) => {
    const { starts, lines } = folded();
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (starts[middle]! <= position) low = middle;
      else high = middle - 1;
    }
    return lines[low]!;
  };
  return (anchor: { start: number; end: number; quote?: string }) => {
    const fits = anchor.end <= texts.length;
    if (!anchor.quote) return fits ? { start: anchor.start, end: anchor.end } : null;
    const wanted = compact(anchor.quote);
    if (fits && compact(texts.slice(anchor.start - 1, anchor.end).join("")).includes(wanted))
      return { start: anchor.start, end: anchor.end };
    const found = folded().joined.indexOf(wanted);
    if (found === -1) return null;
    const start = lineAt(found);
    const end = Math.max(lineAt(found + wanted.length - 1), start + anchor.end - anchor.start);
    return { start, end: Math.min(end, texts.length) };
  };
}

/**
 * An anchor's own label: the heading for a section, the start of the quote for a region (empty
 * when it kept none, for the caller's generic name), else its first and last line or row.
 */
export function anchorRangeLabel(anchor: AttachmentCommentAnchor): string {
  if (anchor.type === "md-section") return anchor.data.headingTitle;
  if (anchor.type === "html-region") {
    const characters = Array.from(anchor.data.quote ?? "");
    return characters.length > REGION_LABEL_MAX
      ? `${characters.slice(0, REGION_LABEL_MAX).join("")}…`
      : characters.join("");
  }
  const { start, end } = anchor.data;
  return start === end ? `${start}` : `${start}–${end}`;
}
