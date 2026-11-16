import { useRef, type RefObject } from "react";
import { CursorClick01 } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { m } from "#src/paraglide/messages";
import { useArtifactCommenting } from "./artifact-commenting";
import { DraftAffordance } from "./artifact-draft-affordance";
import type { PageBridge } from "./artifact-page-bridge";
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
  if (!commenting) return null;
  return (
    <>
      <div
        role="group"
        aria-label={m.av_cm_page_tools()}
        data-comment-tools=""
        className="absolute bottom-4 left-1/2 z-20 -translate-x-1/2 rounded-full border border-secondary bg-primary p-1 shadow-lg"
      >
        <Button
          size="sm"
          color={picking ? "primary" : "secondary"}
          iconLeading={CursorClick01}
          aria-pressed={picking}
          isDisabled={draft.composing !== null}
          data-pick-element=""
          onPress={togglePicking}
        >
          {m.av_cm_pick_element()}
        </Button>
      </div>
      <DraftAffordance draft={draft} path={entryPath} />
    </>
  );
}
