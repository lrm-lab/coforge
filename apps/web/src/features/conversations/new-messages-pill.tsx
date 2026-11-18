import { ArrowDown } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { UnreadBadge } from "#src/components/ui/unread-marker";
import { m } from "#src/paraglide/messages";
import { usePushedNewMessages } from "./pushed-new-messages";

export function NewMessagesPill({
  conversationId,
  rootId,
  viewerId,
  unreadCount,
  onlyNew = false,
  onShowLatest,
}: {
  conversationId: string;
  rootId: string | undefined;
  viewerId: string | undefined;
  unreadCount?: number;
  onlyNew?: boolean;
  onShowLatest: () => void;
}) {
  const pushed = usePushedNewMessages({ conversationId, rootId, viewerId });
  const count = unreadCount ?? pushed;
  if (onlyNew && count === 0) return null;
  const label =
    count === 0
      ? m.conversation_back_to_bottom()
      : count === 1
        ? m.conversation_one_new_message()
        : m.conversation_new_messages({ count });
  // On a phone the label would take the row the replying line needs: the pill is a round arrow
  // there (its label stays for screen readers) and the count rides on it as a badge. It is drawn at
  // 36px; a clear `after:` box 4px around it makes the tap target 44px.
  return (
    <span className="pointer-events-auto relative inline-flex">
      <Button
        size="sm"
        color={count > 0 ? "primary" : "secondary"}
        iconTrailing={ArrowDown}
        onClick={onShowLatest}
        className="rounded-full whitespace-nowrap shadow-md max-md:p-2 max-md:*:data-text:sr-only max-md:after:absolute max-md:after:-inset-1 max-md:after:content-['']"
      >
        {label}
      </Button>
      {count > 0 && (
        <UnreadBadge
          count={count}
          className="pointer-events-none absolute -top-1.5 -right-1.5 md:hidden"
        />
      )}
    </span>
  );
}
