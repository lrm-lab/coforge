import { useRef, type RefObject } from "react";

import { useArtifactCommenting } from "./artifact-commenting";
import { DraftAffordance } from "./artifact-draft-affordance";
import type { PageBridge } from "./artifact-page-bridge";
import { useRegisterFramePicker } from "./artifact-review-tools";
import { useAnchorDraft } from "./use-anchor-draft";
import { useFrameMarks } from "./use-frame-marks";
import { useFrameOffer } from "./use-frame-offer";

export function ArtifactFrameCommentLayer({
  bridge,
  frame,
  container,
}: {
  bridge: PageBridge;
  frame: RefObject<HTMLIFrameElement | null>;
  container: RefObject<HTMLDivElement | null>;
}) {
  const { version, entryPath, commenting } = useArtifactCommenting();
  const key = commenting ? `${entryPath}@${version}` : null;
  const composingRef = useRef(false);
  const { picking, togglePicking, ...offers } = useFrameOffer({
    bridge,
    frame,
    key,
    composing: composingRef,
  });
  useFrameMarks({ bridge, composing: composingRef });
  const draft = useAnchorDraft({ key, frame: container, ...offers });
  composingRef.current = draft.composing !== null;
  useRegisterFramePicker(
    commenting ? { picking, disabled: draft.composing !== null, toggle: togglePicking } : null,
  );
  if (!commenting) return null;
  return <DraftAffordance draft={draft} path={entryPath} />;
}
