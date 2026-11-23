import { CursorBox, XClose } from "@untitledui/icons";

import { Tooltip, TooltipTrigger } from "#src/components/base/tooltip/tooltip";
import { TooltipShortcutLabel } from "#src/components/ui/kbd";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { ArtifactCommentButton } from "./artifact-comment-button";

export function ArtifactHeaderComments({
  html,
  total,
  annotating,
  panelActive,
  onToggleAnnotate,
  onTogglePanel,
}: {
  html: boolean;
  total: number | undefined;
  annotating: boolean;
  panelActive: boolean;
  onToggleAnnotate: () => void;
  onTogglePanel: () => void;
}) {
  return (
    <>
      {html && (
        <Tooltip
          title={
            annotating ? (
              <TooltipShortcutLabel label={m.av_cm_exit_annotate()} shortcut="Escape" />
            ) : (
              m.av_cm_pick_prompt()
            )
          }
        >
          <TooltipTrigger
            aria-label={annotating ? m.av_cm_exit_annotate() : m.av_cm_annotate_short()}
            aria-pressed={annotating}
            data-annotate-toggle=""
            data-picking={String(annotating)}
            onPress={onToggleAnnotate}
            className={cn(
              "relative flex h-8 shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-lg px-2.5 text-xs font-medium outline-focus-ring transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 max-sm:w-8 max-sm:px-0 any-pointer-coarse:after:absolute any-pointer-coarse:after:-inset-1.5",
              annotating
                ? "bg-brand-secondary text-brand-secondary hover:bg-brand-secondary"
                : "text-fg-quaternary hover:bg-primary_hover hover:text-secondary",
            )}
          >
            <CursorBox
              aria-hidden="true"
              className={cn("size-4 shrink-0", annotating && "text-fg-brand-primary")}
            />
            <span className="max-sm:hidden">
              {annotating ? m.av_cm_annotating() : m.av_cm_annotate_short()}
            </span>
            {annotating && (
              <XClose aria-hidden="true" className="size-3.5 shrink-0 max-sm:hidden" />
            )}
          </TooltipTrigger>
        </Tooltip>
      )}
      <ArtifactCommentButton total={total} active={panelActive} onToggle={onTogglePanel} />
    </>
  );
}
