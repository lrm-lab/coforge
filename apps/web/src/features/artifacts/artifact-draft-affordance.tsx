import { useEffect } from "react";
import { MessageSquare01 } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { m } from "#src/paraglide/messages";
import { useArtifactCommenting } from "./artifact-commenting";
import {
  OFFER_HEIGHT_PX,
  OFFER_WIDTH_PX,
  clampWithin,
  type AnchorDraftState,
} from "./use-anchor-draft";

export function DraftAffordance({ draft, path }: { draft: AnchorDraftState; path: string }) {
  const { version, setPickedAnchor } = useArtifactCommenting();
  const { offer, composing, compose, close, retarget } = draft;

  useEffect(() => {
    if (!composing) {
      setPickedAnchor(null);
      return;
    }
    setPickedAnchor({
      path,
      version,
      anchor: composing.draft.anchor,
      trail: composing.draft.trail,
      onRetarget: retarget,
      onClear: close,
    });
    return () => setPickedAnchor(null);
  }, [composing, path, version, retarget, close, setPickedAnchor]);

  if (!offer) return null;
  return (
    <div
      data-comment-selection=""
      style={{
        top: clampWithin(offer.top, offer.bounds.height, OFFER_HEIGHT_PX),
        left: clampWithin(offer.left, offer.bounds.width, OFFER_WIDTH_PX),
      }}
      className="absolute z-20 shadow-lg"
    >
      <Button size="sm" color="secondary" iconLeading={MessageSquare01} onPress={compose}>
        {m.av_cm_add_comment()}
      </Button>
    </div>
  );
}
