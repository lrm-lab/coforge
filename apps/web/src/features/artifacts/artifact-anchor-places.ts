import type { AffordanceRect } from "#src/features/conversations/message-quote";
import type { CommentAnchor } from "./artifact-comment-inputs";

export const COMMENT_FOCUS_HIGHLIGHT = "artifact-comment-focus";
export const COMMENT_DRAFT_HIGHLIGHT = "artifact-comment-draft";

export const MARGIN_MIN_PX = 44;
export const MARGIN_OFFSET_PX = 4;

export function computeMarkerLeft(
  outer: { left: number; right: number },
  inner: { right: number },
): number | null {
  return outer.right - inner.right >= MARGIN_MIN_PX
    ? inner.right - outer.left + MARGIN_OFFSET_PX
    : null;
}

export type AnchorLocation = { range: Range; element: Element; order: number };

export type Place<Location extends { order: number }> =
  | { status: "found"; location: Location }
  | { status: "neutral" };

export type PublishedPlace = Place<{ order: number }>;

export type AnchorPlace = Place<AnchorLocation>;

export type AnchorStatus = AnchorPlace["status"] | "elsewhere";

export const NEUTRAL = { status: "neutral" } as const;

export type DraftTarget = {
  rect: AffordanceRect;
  at?: { x: number; y: number };
  highlight(on: boolean): void;
};

export type DraftTrail = { names: readonly string[]; at: number; step(index: number): AnchorDraft };

export type AnchorDraft = { anchor: CommentAnchor; target: DraftTarget; trail?: DraftTrail };

export type SurfaceAdapter<Index, Selection> = {
  build(root: Element): Index | null;
  locate(index: Index, anchor: CommentAnchor): AnchorPlace;
  fromSelection(index: Index, selection: Selection): AnchorDraft | null;
};
