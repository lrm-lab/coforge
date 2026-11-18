import { Fragment, useEffect, useRef, type KeyboardEvent } from "react";
import { XClose } from "@untitledui/icons";
import { Button as AriaButton } from "react-aria-components";

import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { FLOATING_SURFACE_CLASS } from "#src/features/conversations/review-chrome";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { describeAnchor } from "./artifact-comment-anchor";
import { ArtifactCommentComposer } from "./artifact-comment-composer";
import type { AnchorDraft, DraftTrail } from "./artifact-anchor-places";
import type { CommentAnchor } from "./artifact-comment-inputs";

export function ArtifactCommentPopover({
  artifactId,
  version,
  path,
  anchor,
  suggestion,
  trail,
  onRetarget,
  top,
  left,
  onClose,
}: {
  artifactId: string;
  version: number;
  path: string;
  anchor: CommentAnchor;
  suggestion?: string | undefined;
  trail?: DraftTrail | undefined;
  onRetarget?: (draft: AnchorDraft) => void;
  top: number;
  left: number;
  onClose: () => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    root.current?.scrollIntoView({ block: "nearest" });
  }, []);
  const { place, excerpt } = describeAnchor(anchor);
  return (
    <div
      ref={root}
      role="dialog"
      aria-label={m.av_cm_selection_label()}
      data-comment-popover=""
      style={{ top, left }}
      className={cn(
        "absolute z-20 w-88 max-w-[calc(100%-1rem)] origin-top animate-in fade-in zoom-in-[0.97] motion-enter-sm",
        FLOATING_SURFACE_CLASS,
      )}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.defaultPrevented) {
          event.stopPropagation();
          onClose();
          return;
        }
        const next = trail && arrowStep(event, trail);
        if (next !== undefined) {
          event.preventDefault();
          onRetarget?.(trail!.step(next));
        }
      }}
    >
      <ArtifactCommentComposer
        artifactId={artifactId}
        target={{
          kind: "anchor",
          version,
          path,
          anchor,
          suggestion,
          header: (
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1 space-y-1 pt-1.5 text-xs text-tertiary">
                {trail && (
                  <TrailLine trail={trail} onStep={(index) => onRetarget?.(trail.step(index))} />
                )}
                <p className="line-clamp-3 [overflow-wrap:anywhere]">
                  {place && <span className="block text-secondary">{place}</span>}
                  {excerpt && <span className="block">{excerpt}</span>}
                </p>
              </div>
              <ButtonUtility
                icon={XClose}
                size="xs"
                color="tertiary"
                tooltip={m.av_cm_anchor_cancel()}
                onClick={onClose}
              />
            </div>
          ),
        }}
        focusRequest={1}
        className="border-t-0"
        onPosted={onClose}
      />
    </div>
  );
}

function arrowStep(event: KeyboardEvent<HTMLDivElement>, { names, at }: DraftTrail) {
  const field = event.target;
  const step = event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0;
  const next = at + step;
  if (
    step === 0 ||
    event.defaultPrevented ||
    event.nativeEvent.isComposing ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey ||
    !(field instanceof HTMLTextAreaElement) ||
    field.value !== "" ||
    next < 0 ||
    next >= names.length
  )
    return undefined;
  return next;
}

function TrailLine({
  trail: { names, at },
  onStep,
}: {
  trail: DraftTrail;
  onStep: (index: number) => void;
}) {
  return (
    <nav aria-label={m.av_cm_element_path()} className="mb-0.5">
      <ol className="flex flex-wrap items-center gap-x-1 font-mono text-xs">
        {names.map((name, index) => (
          <Fragment key={index}>
            {index > 0 && (
              <li aria-hidden="true" className="text-quaternary">
                ›
              </li>
            )}
            <li className="min-w-0">
              <AriaButton
                aria-current={index === at ? "location" : undefined}
                data-trail-step={index}
                preventFocusOnPress
                onPress={() => onStep(index)}
                className={cn(
                  "max-w-48 truncate rounded-sm outline-focus-ring focus-visible:outline-2",
                  index === at
                    ? "font-medium text-secondary"
                    : "cursor-pointer text-tertiary hover:text-secondary",
                )}
              >
                {name}
              </AriaButton>
            </li>
          </Fragment>
        ))}
      </ol>
    </nav>
  );
}
