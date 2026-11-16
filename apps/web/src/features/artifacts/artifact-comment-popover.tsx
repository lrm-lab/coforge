import { useEffect, useRef } from "react";
import { XClose } from "@untitledui/icons";

import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { m } from "#src/paraglide/messages";
import { describeAnchor } from "./artifact-comment-anchor";
import { ArtifactCommentComposer } from "./artifact-comment-composer";
import type { CommentAnchor } from "./artifact-comment-inputs";

export function ArtifactCommentPopover({
  artifactId,
  version,
  path,
  anchor,
  top,
  left,
  onClose,
}: {
  artifactId: string;
  version: number;
  path: string;
  anchor: CommentAnchor;
  top: number;
  left: number;
  onClose: () => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    root.current?.scrollIntoView({ block: "nearest" });
  }, []);
  const { quote, place } = describeAnchor(anchor);
  return (
    <div
      ref={root}
      role="dialog"
      aria-label={m.av_cm_selection_label()}
      data-comment-popover=""
      style={{ top, left }}
      className="absolute z-20 w-[22rem] max-w-[calc(100%-1rem)] rounded-xl border border-secondary bg-primary shadow-lg"
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.defaultPrevented) {
          event.stopPropagation();
          onClose();
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
          header: (
            <div className="flex items-start gap-1">
              <p className="line-clamp-3 min-w-0 flex-1 py-1 text-xs text-tertiary italic [overflow-wrap:anywhere]">
                {quote ? m.av_cm_anchor_quote({ quote }) : place}
              </p>
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
        className="border-t-0 pt-2"
        onPosted={onClose}
      />
    </div>
  );
}
