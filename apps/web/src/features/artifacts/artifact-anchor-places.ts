import type { AffordanceRect } from "#src/features/conversations/message-quote";
import type { CommentAnchor } from "./artifact-comment-inputs";

export const COMMENT_FOCUS_HIGHLIGHT = "artifact-comment-focus";
export const COMMENT_DRAFT_HIGHLIGHT = "artifact-comment-draft";

export type AnchorLocation = { range: Range; element: Element; order: number };

export type Place<Location extends { order: number }> =
  | { status: "found"; location: Location }
  | { status: "changed" | "neutral" };

export type PublishedPlace = Place<{ order: number }>;

export type AnchorPlace = Place<AnchorLocation>;

export type AnchorStatus = AnchorPlace["status"] | "missing";

export const CHANGED = { status: "changed" } as const;
export const NEUTRAL = { status: "neutral" } as const;

export type DraftTarget = {
  rect: AffordanceRect;
  highlight(on: boolean): void;
};

export type AnchorDraft = { anchor: CommentAnchor; target: DraftTarget };

export type SurfaceAdapter<Index, Selection> = {
  build(root: Element): Index | null;
  locate(index: Index, anchor: CommentAnchor): AnchorPlace;
  fromSelection(index: Index, selection: Selection): AnchorDraft | null;
};
