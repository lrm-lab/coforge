import { useCallback, useEffect, useMemo, useState, type RefObject } from "react";

import { selectionAffordancePlacement } from "#src/features/conversations/message-quote";
import type { AnchorDraft } from "./artifact-anchor-places";

export const POPOVER_WIDTH_PX = 352;

export type PlacedDraft = { draft: AnchorDraft; top: number; left: number };

const placed = (draft: AnchorDraft, frame: Element | null): PlacedDraft => {
  const { top, left } = selectionAffordancePlacement(
    draft.target.rect,
    frame?.getBoundingClientRect() ?? { top: 0, right: 0, bottom: 0, left: 0, width: 0, height: 0 },
    undefined,
    "below",
  );
  return { draft, top, left };
};

export function useAnchorDraft({
  key,
  offered,
  frame,
  paintOffer,
  onDismiss,
}: {
  key: string | null;
  offered: AnchorDraft | null;
  frame: RefObject<Element | null>;
  paintOffer: boolean;
  onDismiss: () => void;
}) {
  const [composingState, setComposing] = useState<{ key: string; draft: PlacedDraft } | null>(null);
  const composing = composingState && composingState.key === key ? composingState.draft : null;
  const offer = useMemo(
    () => (offered && !composing ? placed(offered, frame.current) : null),
    [offered, composing, frame],
  );

  useEffect(() => {
    if (composingState && composingState.key !== key) setComposing(null);
  }, [composingState, key]);

  const painted = composing?.draft ?? (paintOffer ? offer?.draft : null) ?? null;
  useEffect(() => {
    painted?.target.highlight(true);
    return () => painted?.target.highlight(false);
  }, [painted]);

  const compose = useCallback(() => {
    if (offer && key !== null) setComposing({ key, draft: offer });
  }, [offer, key]);
  const close = useCallback(() => {
    setComposing(null);
    onDismiss();
  }, [onDismiss]);

  return { offer, composing, compose, close };
}
