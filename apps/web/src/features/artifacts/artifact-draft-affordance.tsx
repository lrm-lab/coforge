import { MessageSquare01 } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { m } from "#src/paraglide/messages";
import { ArtifactCommentPopover } from "./artifact-comment-popover";
import { useArtifactCommenting } from "./artifact-commenting";
import {
  OFFER_HEIGHT_PX,
  OFFER_WIDTH_PX,
  POPOVER_HEIGHT_PX,
  POPOVER_WIDTH_PX,
  clampWithin,
  type AnchorDraftState,
} from "./use-anchor-draft";

export function DraftAffordance({ draft, path }: { draft: AnchorDraftState; path: string }) {
  const { artifactId, version } = useArtifactCommenting();
  const { offer, composing, opened, compose, close, retarget } = draft;

  return (
    <>
      {offer && (
        <div
          data-comment-selection=""
          style={{
            top: clampWithin(offer.top, offer.bounds.height, OFFER_HEIGHT_PX),
            left: clampWithin(offer.left, offer.bounds.width, OFFER_WIDTH_PX),
          }}
          className="absolute z-20 rounded-lg shadow-lg"
        >
          <Button size="sm" color="secondary" iconLeading={MessageSquare01} onPress={compose}>
            {m.av_cm_add_comment()}
          </Button>
        </div>
      )}
      {composing && (
        <ArtifactCommentPopover
          key={opened}
          artifactId={artifactId}
          version={version}
          path={path}
          anchor={composing.draft.anchor}
          trail={composing.draft.trail}
          onRetarget={retarget}
          top={clampWithin(composing.top, composing.bounds.height, POPOVER_HEIGHT_PX)}
          left={clampWithin(composing.left, composing.bounds.width, POPOVER_WIDTH_PX)}
          onClose={close}
        />
      )}
    </>
  );
}
