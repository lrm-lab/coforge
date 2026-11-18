import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";

import { selectionAffordancePlacement } from "#src/features/conversations/message-quote";
import type { AnchorDraft } from "./artifact-anchor-places";
import { useArtifactCommenting } from "./artifact-commenting";
import { sameAnchor } from "./artifact-page-annotations";

export const POPOVER_WIDTH_PX = 352;
export const POPOVER_HEIGHT_PX = 280;
export const OFFER_WIDTH_PX = 144;
export const OFFER_HEIGHT_PX = 40;
const EDGE_PX = 8;

export const clampWithin = (value: number, size: number, extent: number) =>
  Math.max(EDGE_PX, Math.min(value, size - extent - EDGE_PX));

export type PlacedDraft = {
  draft: AnchorDraft;
  top: number;
  left: number;
  bounds: { width: number; height: number };
};

export type AnchorDraftState = ReturnType<typeof useAnchorDraft>;

const EMPTY_BOX = { top: 0, right: 0, bottom: 0, left: 0, width: 0, height: 0 };

const POINT_GAP_PX = 12;

const placed = (draft: AnchorDraft, frame: Element | null): PlacedDraft => {
  const box = frame?.getBoundingClientRect() ?? EMPTY_BOX;
  const { at } = draft.target;
  const { top, left } = at
    ? { top: at.y - box.top + POINT_GAP_PX, left: at.x - box.left + POINT_GAP_PX }
    : selectionAffordancePlacement(draft.target.rect, box, undefined, "below");
  return { draft, top, left, bounds: { width: box.width, height: box.height } };
};

export function useAnchorDraft({
  key,
  offered,
  frame,
  paintOffer,
  autoCompose = false,
  onDismiss,
}: {
  key: string | null;
  offered: AnchorDraft | null;
  frame: RefObject<Element | null>;
  paintOffer: boolean;
  autoCompose?: boolean;
  onDismiss: () => void;
}) {
  const { holds } = useArtifactCommenting();
  const openings = useRef(0);
  const [composingState, setComposing] = useState<{
    key: string;
    draft: PlacedDraft;
    opened: number;
  } | null>(null);
  const [placedOffer, setPlacedOffer] = useState<PlacedDraft | null>(null);
  const composing = composingState && composingState.key === key ? composingState.draft : null;
  const offer = useMemo(
    () => (placedOffer && placedOffer.draft === offered && !composing ? placedOffer : null),
    [placedOffer, offered, composing],
  );

  useEffect(() => {
    setPlacedOffer(offered ? placed(offered, frame.current) : null);
  }, [offered, frame]);

  useEffect(() => {
    if (composingState && composingState.key !== key) setComposing(null);
  }, [composingState, key]);

  const painted = composing?.draft ?? (paintOffer ? offer?.draft : null) ?? null;
  useEffect(() => {
    painted?.target.highlight(true);
    return () => painted?.target.highlight(false);
  }, [painted]);

  const compose = useCallback(() => {
    if (offer && key !== null) setComposing({ key, draft: offer, opened: ++openings.current });
  }, [offer, key]);
  const close = useCallback(() => {
    setComposing(null);
    onDismiss();
  }, [onDismiss]);
  const retarget = useCallback((draft: AnchorDraft) => {
    setComposing((current) => current && { ...current, draft: { ...current.draft, draft } });
  }, []);

  useEffect(() => {
    if (key === null || !placedOffer || placedOffer.draft !== offered) return;
    const opened = ++openings.current;
    setComposing((current) => {
      if (
        current &&
        (sameAnchor(current.draft.draft.anchor, placedOffer.draft.anchor) || holds.any())
      )
        return current;
      return autoCompose ? { key, draft: placedOffer, opened } : null;
    });
  }, [autoCompose, key, placedOffer, offered, holds]);

  return {
    offer,
    composing,
    opened: composing ? composingState!.opened : 0,
    compose,
    close,
    retarget,
  };
}
