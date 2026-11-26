import { useCallback, useState, type ReactNode } from "react";
import { MessageSquare01 } from "@untitledui/icons";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { useBreakpoint } from "#src/hooks/use-breakpoint";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { ATTACHMENT_COMMENTS_COLUMN } from "./conversation-list-width";
import { TOOLBAR_BUTTON_ON_CLASS } from "./review-chrome";
import { ResizableColumnSplit } from "./use-resizable-column";

export function useReviewComments(open = false) {
  const [expanded, setExpanded] = useState(open);
  const [onPhone, setOnPhone] = useState(open);
  const shown = expanded || onPhone;
  const show = useCallback(() => {
    setExpanded(true);
    setOnPhone(true);
  }, []);
  return {
    expanded,
    onPhone,
    shown,
    show,
    toggle: () => {
      setExpanded(!shown);
      setOnPhone(!shown);
    },
    hide: () => {
      setExpanded(false);
      setOnPhone(false);
    },
    showFileOnPhone: () => setOnPhone(false),
  };
}

export function ReviewCommentsToggle({
  comments,
}: {
  comments: Pick<ReturnType<typeof useReviewComments>, "shown" | "toggle">;
}) {
  return (
    <ButtonUtility
      icon={MessageSquare01}
      size="xs"
      color="tertiary"
      tooltip={m.attachment_comments_title()}
      aria-pressed={comments.shown}
      className={comments.shown ? TOOLBAR_BUTTON_ON_CLASS : undefined}
      onClick={comments.toggle}
    />
  );
}

export function ReviewSplitLayout({
  comments,
  commentable,
  file,
  fileClassName,
  commentsPane,
}: {
  comments: Pick<ReturnType<typeof useReviewComments>, "expanded" | "onPhone">;
  commentable: boolean;
  file: ReactNode;
  fileClassName?: string;
  commentsPane?: ReactNode;
}) {
  const desktop = useBreakpoint("lg");
  const hidden = !comments.expanded;

  if (desktop && commentable) {
    return (
      <ResizableColumnSplit
        id="coforge-attachment-comments"
        column={ATTACHMENT_COMMENTS_COLUMN}
        active
        hidden={hidden}
        side="end"
        siblingOverflow="hidden"
        siblingContent={
          <div className={cn("flex min-h-0 min-w-0 flex-1 flex-col", fileClassName)}>{file}</div>
        }
        columnContent={
          <div
            inert={hidden || undefined}
            aria-hidden={hidden || undefined}
            className={cn("flex min-h-0 min-w-0 flex-1 flex-col", hidden && "hidden")}
          >
            {commentsPane}
          </div>
        }
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-1">
      <div
        className={cn(
          "min-h-0 min-w-0 flex-1 flex-col lg:flex",
          comments.onPhone ? "hidden" : "flex",
          fileClassName,
        )}
      >
        {file}
      </div>
      {commentable && (
        <div
          data-review-comments=""
          className={cn("relative min-h-0 min-w-0 flex-1", comments.onPhone ? "block" : "hidden")}
        >
          {commentsPane}
        </div>
      )}
    </div>
  );
}
