import { z } from "zod";

import { CHANGED, type PublishedPlace } from "./artifact-anchor-places";
import type { CommentAnchor } from "./artifact-comment-inputs";
import type { ThreadPlaces } from "./artifact-commenting";

export const MARKS_MAX = 500;
export const ELEMENT_SELECTOR_MAX = 1000;
export const ELEMENT_LABEL_MAX = 120;
export const TEXT_QUOTE_MAX = 4000;
export const TEXT_CONTEXT_MAX = 64;
export const MARK_LABEL_MAX = 300;

export type FrameRect = {
  top: number;
  right: number;
  bottom: number;
  left: number;
  width: number;
  height: number;
};

export type PageAnnotationMode = { picking: boolean; selecting: boolean; showMarks: boolean };

export type PageMark = {
  id: string;
  anchor: CommentAnchor;
  count: number;
  label: string;
  draft?: true;
};

export type PickFailure = "unanchorable";

export type PickedAnchor = { anchor: CommentAnchor; rect: FrameRect };

const noNul = (value: string) => !value.includes("\u0000");
const text = (min: number, max: number) => z.string().min(min).max(max).refine(noNul);
const coordinate = z.number().finite().min(-1e6).max(1e6);

const rect = z
  .object({
    top: coordinate,
    right: coordinate,
    bottom: coordinate,
    left: coordinate,
    width: coordinate,
    height: coordinate,
  })
  .strict();

const element = z
  .object({
    type: z.literal("element"),
    data: z
      .object({
        selector: text(1, ELEMENT_SELECTOR_MAX),
        quote: text(1, ELEMENT_LABEL_MAX).optional(),
      })
      .strict(),
    rect,
  })
  .strict();

const quotation = z
  .object({
    type: z.literal("text"),
    data: z
      .object({
        quote: text(1, TEXT_QUOTE_MAX),
        prefix: text(0, TEXT_CONTEXT_MAX).optional(),
        suffix: text(0, TEXT_CONTEXT_MAX).optional(),
      })
      .strict(),
    rect,
  })
  .strict();

const picked = z.discriminatedUnion("type", [element, quotation]);

export function parsePicked(value: unknown): PickedAnchor | null {
  const parsed = picked.safeParse(value);
  if (!parsed.success) return null;
  const { rect: box, ...anchor } = parsed.data;
  return { anchor: anchor as CommentAnchor, rect: box };
}

export function parseFoundIds(value: unknown, known: ReadonlySet<string>): string[] {
  if (!Array.isArray(value)) return [];
  const ids = new Set<string>();
  for (const id of value.slice(0, MARKS_MAX))
    if (typeof id === "string" && known.has(id)) ids.add(id);
  return [...ids];
}

export const isFrameAnchor = (anchor: CommentAnchor | null): anchor is CommentAnchor =>
  anchor !== null && (anchor.type === "element" || anchor.type === "text");

export function clipAnchor(anchor: CommentAnchor): CommentAnchor {
  const { data } = anchor;
  const text = (value: unknown, max: number, tail = false) =>
    typeof value === "string" && value.length > max
      ? tail
        ? value.slice(-max).replace(/^[\uDC00-\uDFFF]/, "")
        : value.slice(0, max).replace(/[\uD800-\uDBFF]$/, "")
      : value;
  if (anchor.type === "element")
    return {
      ...anchor,
      data: {
        ...data,
        selector: text(data.selector, ELEMENT_SELECTOR_MAX),
        ...(data.quote === undefined ? {} : { quote: text(data.quote, ELEMENT_LABEL_MAX) }),
      },
    };
  if (anchor.type === "text")
    return {
      ...anchor,
      data: {
        ...data,
        quote: text(data.quote, TEXT_QUOTE_MAX),
        ...(data.prefix === undefined ? {} : { prefix: text(data.prefix, TEXT_CONTEXT_MAX, true) }),
        ...(data.suffix === undefined ? {} : { suffix: text(data.suffix, TEXT_CONTEXT_MAX) }),
      },
    };
  return anchor;
}

export function sameAnchor(left: CommentAnchor, right: CommentAnchor): boolean {
  const keys = Object.keys(left.data);
  return (
    left.type === right.type &&
    keys.length === Object.keys(right.data).length &&
    keys.every((key) => left.data[key] === right.data[key])
  );
}

export function markPlaces(
  marks: readonly PageMark[],
  foundIds: readonly string[] | null,
): ThreadPlaces {
  if (!foundIds) return new Map();
  const places = new Map<string, PublishedPlace>();
  for (const { id } of marks.slice(0, MARKS_MAX)) {
    const order = foundIds.indexOf(id);
    places.set(id, order >= 0 ? { status: "found", location: { order } } : CHANGED);
  }
  return places;
}
