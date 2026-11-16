import type { AffordanceRect } from "#src/features/conversations/message-quote";
import type { CommentAnchor } from "./artifact-comment-inputs";

export const COMMENT_FOCUS_HIGHLIGHT = "artifact-comment-focus";
export const COMMENT_DRAFT_HIGHLIGHT = "artifact-comment-draft";

export type AnchorLocation = { range: Range; element: Element; order: number };

export type AnchorPlace =
  | { status: "found"; location: AnchorLocation }
  | { status: "changed" | "neutral" };

export type AnchorStatus = AnchorPlace["status"] | "missing";

export const CHANGED: AnchorPlace = { status: "changed" };
export const NEUTRAL: AnchorPlace = { status: "neutral" };

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
