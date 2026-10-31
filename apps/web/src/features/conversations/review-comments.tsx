import { useState, type ReactNode } from "react";
import { MessageSquare01 } from "@untitledui/icons";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { ConversationListResizeHandle } from "./conversation-list-resize-handle";
import { ATTACHMENT_COMMENTS_COLUMN } from "./conversation-list-width";
import { TOOLBAR_ICON } from "./review-title";

/**
 * Whether a review shows its comments: beside the file from `lg` up (`expanded`), or in its place
 * below that (`onPhone`). A review opens on the file alone, or, when a link names it, straight at
 * its comments (`open`).
 */
export function useReviewComments(open = false) {
  const [expanded, setExpanded] = useState(open);
  const [onPhone, setOnPhone] = useState(open);
  const shown = expanded || onPhone;
  return {
    expanded,
    onPhone,
    shown,
    /** Both at once, as a place picked in the preview or a link opening the comments does. */
    show: () => {
      setExpanded(true);
      setOnPhone(true);
    },
    toggle: () => {
      setExpanded(!shown);
      setOnPhone(!shown);
    },
    hide: () => {
      setExpanded(false);
      setOnPhone(false);
    },
    /** Back to the file on a phone, as jumping to a comment's place does. */
    showFileOnPhone: () => setOnPhone(false),
  };
}

/** The review bar's comments button, pressed while they show. */
export function ReviewCommentsToggle({
  comments,
}: {
  comments: Pick<ReturnType<typeof useReviewComments>, "shown" | "toggle">;
}) {
  return (
    <ButtonUtility
      icon={MessageSquare01}
      size="sm"
      color="tertiary"
      tooltip={m.attachment_comments_title()}
      aria-pressed={comments.shown}
      className={cn(TOOLBAR_ICON, comments.shown && "bg-brand-primary_alt text-fg-brand-primary")}
      onClick={comments.toggle}
    />
  );
}

/** The comments column of a review, at the width the reader last dragged it to. */
export function ReviewCommentsColumn({
  comments,
  children,
}: {
  comments: Pick<ReturnType<typeof useReviewComments>, "expanded" | "onPhone">;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "relative min-h-0 min-w-0 flex-1",
        // Kept width, set on <html> by the boot script and the handle; never more than half the
        // dialog, so the preview keeps the other half.
        "lg:w-(--attachment-comments-width,20rem) lg:max-w-1/2 lg:flex-none lg:border-l lg:border-secondary",
        comments.expanded ? "lg:block" : "lg:hidden",
        comments.onPhone ? "block" : "hidden",
      )}
    >
      <ConversationListResizeHandle column={ATTACHMENT_COMMENTS_COLUMN} />
      {children}
    </div>
  );
}

/** The file's side of a review: hidden on a phone while the comments take its place. */
export function reviewFileClass(comments: Pick<ReturnType<typeof useReviewComments>, "onPhone">) {
  return cn("min-h-0 min-w-0 flex-1 flex-col lg:flex", comments.onPhone ? "hidden" : "flex");
}
