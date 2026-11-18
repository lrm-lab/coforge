import { useRef, type RefObject } from "react";

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
  const { version, commenting } = useArtifactCommenting();
  const key = commenting ? `${path}@${version}` : null;
  const composingRef = useRef(false);
  const offers = useFrameOffer({
    bridge,
    frame,
    key,
    composing: composingRef,
  });
  useFrameMarks({ bridge, composing: composingRef, path });
  const draft = useAnchorDraft({ key, frame: container, ...offers });
  composingRef.current = draft.composing !== null;
  return (
    <>
      {commenting && <DraftAffordance draft={draft} path={path} />}
      <PageSuggestion
        path={path}
        suggestions={suggestions}
        container={container}
        composing={composingRef}
      />
    </>
  );
}
