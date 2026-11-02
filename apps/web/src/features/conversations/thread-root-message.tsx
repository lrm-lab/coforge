import type { ComponentProps } from "react";

import { m } from "#src/paraglide/messages";

import { MessageRow } from "./message-row";

type ThreadRootMessageProps = Omit<
  ComponentProps<typeof MessageRow>,
  "dayChanged" | "grouped" | "unreadStartsHere"
>;

/** The message a thread pane answers, above its replies. */
export function ThreadRootMessage(props: ThreadRootMessageProps) {
  return (
    <div aria-label={m.conversation_thread_root()} className="border-b border-secondary py-3">
      {/* The root is an ordinary message row so it keeps every message affordance
        (hover toolbar on wide shells, tap action sheet below `lg`, reactions, action
        cards, quote-selection) instead of being a bespoke display-only block. Only the
        thread entry is held back: this pane already is that message's thread. The one-
        item list keeps the li valid; the rule under it separates the root from its
        replies. */}
      <ol className="flex flex-col">
        <MessageRow {...props} dayChanged={false} grouped={false} unreadStartsHere={false} />
      </ol>
    </div>
  );
}
