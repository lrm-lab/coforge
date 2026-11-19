import { useEffect, useState } from "react";
import { FlipBackward, FlipForward, MessageSquare01 } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { ConfirmDialog } from "#src/components/ui/confirm-dialog";
import {
  FLOATING_SURFACE_CLASS,
  TOOLBAR_BUTTON_ON_CLASS,
} from "#src/features/conversations/review-chrome";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { useCommentDraftActions, useCommentDrafts } from "./artifact-comment-drafts-context";

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return true;
  return target.closest('[role="dialog"], [aria-modal="true"]') !== null;
}

export function ArtifactReviewPill({
  annotating,
  onToggleAnnotate,
  onExitAnnotate,
}: {
  annotating: boolean;
  onToggleAnnotate: () => void;
  onExitAnnotate: () => void;
}) {
  const drafts = useCommentDrafts();
  const actions = useCommentDraftActions();
  const [discarding, setDiscarding] = useState(false);
  const count = drafts.drafts.length;
  const locked = drafts.busy;
  const hasHistory = drafts.canUndo || drafts.canRedo;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      if (isEditableTarget(event.target)) return;
      if (event.key === "Escape" && annotating) {
        event.preventDefault();
        onExitAnnotate();
        return;
      }
      if (event.key === "c" || event.key === "C") {
        event.preventDefault();
        onToggleAnnotate();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [annotating, onToggleAnnotate, onExitAnnotate]);

  return (
    <>
      <div
        role="group"
        aria-label={m.av_dr_tools()}
        data-comment-tools=""
        className={cn(
          "absolute right-4 bottom-4 z-20 flex max-w-[calc(100%-2rem)] items-center gap-1 p-1",
          FLOATING_SURFACE_CLASS,
          annotating && "ring-2 ring-brand/30",
        )}
      >
        <Button
          size="xs"
          color="tertiary"
          iconLeading={MessageSquare01}
          aria-pressed={annotating}
          data-annotate-toggle=""
          className={cn(annotating && TOOLBAR_BUTTON_ON_CLASS)}
          onPress={onToggleAnnotate}
        >
          {annotating ? m.av_cm_annotating() : m.av_cm_annotate()}
        </Button>
        {(hasHistory || count > 0) && (
          <>
            <Divider />
            <ButtonUtility
              icon={FlipBackward}
              size="xs"
              color="tertiary"
              tooltip={m.av_dr_undo()}
              isDisabled={!drafts.canUndo || locked}
              data-draft-undo=""
              onClick={actions.undo}
            />
            <ButtonUtility
              icon={FlipForward}
              size="xs"
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
              size="xs"
              color="tertiary"
              isDisabled={locked}
              data-draft-discard=""
              onPress={() => setDiscarding(true)}
            >
              {m.av_dr_discard()}
            </Button>
            <Button
              size="xs"
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

const Divider = () => <span aria-hidden="true" className="mx-1 h-4 border-l border-secondary" />;
