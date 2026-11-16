import { useState } from "react";
import { CursorClick01, FlipBackward, FlipForward } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { ConfirmDialog } from "#src/components/ui/confirm-dialog";
import { m } from "#src/paraglide/messages";
import { useCommentDraftActions, useCommentDrafts } from "./artifact-comment-drafts-context";
import type { FramePicker } from "./artifact-review-tools";

export function ArtifactReviewPill({ picker }: { picker: FramePicker | null }) {
  const drafts = useCommentDrafts();
  const actions = useCommentDraftActions();
  const [discarding, setDiscarding] = useState(false);
  const count = drafts.drafts.length;
  const history = drafts.canUndo || drafts.canRedo || count > 0;
  if (picker === null && count === 0) return null;
  const locked = drafts.busy;
  return (
    <>
      <div
        role="group"
        aria-label={m.av_dr_tools()}
        data-comment-tools=""
        className="absolute bottom-4 left-1/2 z-20 flex max-w-[calc(100%-1rem)] -translate-x-1/2 items-center gap-1 rounded-full border border-secondary bg-primary p-1 shadow-lg"
      >
        {picker && (
          <Button
            size="sm"
            color={picker.picking ? "primary" : "secondary"}
            iconLeading={CursorClick01}
            aria-pressed={picker.picking}
            isDisabled={picker.disabled}
            data-pick-element=""
            onPress={picker.toggle}
          >
            {m.av_cm_pick_element()}
          </Button>
        )}
        {picker && history && <Divider />}
        {history && (
          <>
            <ButtonUtility
              icon={FlipBackward}
              size="sm"
              color="tertiary"
              tooltip={m.av_dr_undo()}
              isDisabled={!drafts.canUndo || locked}
              data-draft-undo=""
              onClick={actions.undo}
            />
            <ButtonUtility
              icon={FlipForward}
              size="sm"
              color="tertiary"
              tooltip={m.av_dr_redo()}
              isDisabled={!drafts.canRedo || locked}
              data-draft-redo=""
              onClick={actions.redo}
            />
          </>
        )}
        {count > 0 && (
          <>
            <Divider />
            <Button
              size="sm"
              color="tertiary"
              isDisabled={locked}
              data-draft-discard=""
              onPress={() => setDiscarding(true)}
            >
              {m.av_dr_discard()}
            </Button>
            <Button
              size="sm"
              color="primary"
              isDisabled={locked}
              isLoading={drafts.submitting}
              data-draft-send=""
              onPress={() => void actions.submit()}
            >
              {m.av_dr_send_n({ count })}
            </Button>
          </>
        )}
      </div>
      <ConfirmDialog
        open={discarding}
        onOpenChange={setDiscarding}
        title={m.av_dr_discard_title({ count })}
        description={m.av_dr_discard_body()}
        confirmLabel={m.av_dr_discard_confirm()}
        errorMessage={m.av_dr_discard_failed()}
        onConfirm={async () => {
          await actions.discardAll();
          setDiscarding(false);
        }}
      />
    </>
  );
}

const Divider = () => <span aria-hidden="true" className="mx-0.5 h-5 border-l border-secondary" />;
