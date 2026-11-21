import { useEffect, useRef, type RefObject } from "react";

import { useArtifactCommenting } from "./artifact-commenting";
import { DraftAffordance } from "./artifact-draft-affordance";
import type { PageBridge, PageSuggestHandler } from "./artifact-page-bridge";
import { PageSuggestion } from "./artifact-page-suggestion";
import { useAnchorDraft } from "./use-anchor-draft";
import { useFrameMarks } from "./use-frame-marks";
import { useFrameOffer } from "./use-frame-offer";

export function ArtifactFrameCommentLayer({
  bridge,
  frame,
  container,
  path,
  suggestions,
}: {
  bridge: PageBridge;
  frame: RefObject<HTMLIFrameElement | null>;
  container: RefObject<HTMLDivElement | null>;
  path: string;
  suggestions: RefObject<PageSuggestHandler | null>;
}) {
  const { version, commenting, pickBus } = useArtifactCommenting();
  const key = `${path}@${version}`;
  const composingRef = useRef(false);
  const offers = useFrameOffer({
    bridge,
    frame,
    path,
    key,
    composing: composingRef,
  });
  useFrameMarks({ bridge, path });
  const draft = useAnchorDraft({ key, frame: container, ...offers });
  composingRef.current = draft.composing !== null;

  useEffect(() => {
    if (!commenting) {
      if (!composingRef.current) bridge.annotations.setDrafts([]);
      return;
    }
    return pickBus.subscribeHighlightedAnchors((anchors) => {
      if (!composingRef.current) bridge.annotations.setDrafts(anchors);
    });
  }, [bridge, commenting, pickBus]);

  return (
    <>
      <DraftAffordance draft={draft} path={path} />
      <PageSuggestion
        path={path}
        suggestions={suggestions}
        container={container}
        composing={composingRef}
      />
    </>
  );
}
