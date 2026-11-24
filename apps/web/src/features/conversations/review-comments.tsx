import { useCallback, useState, type ReactNode } from "react";
import { MessageSquare01 } from "@untitledui/icons";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { ConversationListResizeHandle } from "./conversation-list-resize-handle";
import { ATTACHMENT_COMMENTS_COLUMN } from "./conversation-list-width";
import { TOOLBAR_BUTTON_ON_CLASS } from "./review-chrome";

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

export function reviewFileClass(comments: Pick<ReturnType<typeof useReviewComments>, "onPhone">) {
  return cn("min-h-0 min-w-0 flex-1 flex-col lg:flex", comments.onPhone ? "hidden" : "flex");
}
