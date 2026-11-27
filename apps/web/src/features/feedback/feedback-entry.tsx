import { MessageTextSquare01 } from "@untitledui/icons";
import { Button as AriaButton } from "react-aria-components";

import { RailButton } from "#src/components/layout/sidebar/sidebar-rail";
import { m } from "#src/paraglide/messages";
import { useOpenFeedback } from "./feedback-host";

export function FeedbackRow() {
  const openFeedback = useOpenFeedback();
  return (
    <AriaButton
      aria-haspopup="dialog"
      onPress={openFeedback}
      className="group flex h-10 w-full items-center gap-3 rounded-lg px-3 text-sm font-medium text-nav-fg outline-focus-ring transition-colors duration-100 ease-out hover:bg-sidebar-item-active hover:text-secondary focus-visible:outline-2 focus-visible:outline-offset-2"
    >
      <MessageTextSquare01
        aria-hidden="true"
        className="size-5 shrink-0 text-nav-fg transition-colors duration-100 ease-out group-hover:text-secondary"
      />
      <span className="min-w-0 flex-1 truncate text-left">{m.feedback_entry()}</span>
    </AriaButton>
  );
}

export function FeedbackRailButton() {
  const openFeedback = useOpenFeedback();
  return (
    <RailButton
      icon={MessageTextSquare01}
      label={m.feedback_entry()}
      aria-haspopup="dialog"
      onPress={openFeedback}
    />
  );
}
