import { ArrowDown } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { UnreadBadge, UnreadDot } from "#src/components/ui/unread-marker";
import { m } from "#src/paraglide/messages";
import { cx } from "#src/utils/cx";
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
  return (
    <span className="pointer-events-auto relative inline-flex">
      <Button
        size="xs"
        color="secondary"
        iconLeading={count > 0 ? <UnreadDot className="size-1.5 max-md:hidden" /> : undefined}
        iconTrailing={ArrowDown}
        onClick={onShowLatest}
        className={cx(
          "h-8 rounded-full py-0 text-xs font-medium whitespace-nowrap shadow-xs ring-secondary max-md:w-8 max-md:p-0 max-md:*:data-text:sr-only max-md:after:absolute max-md:after:-inset-1.5 max-md:after:content-['']",
          count > 0 && "text-primary tabular-nums hover:text-primary",
        )}
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
