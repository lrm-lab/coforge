import { ArrowDown } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { m } from "#src/paraglide/messages";
import { usePushedNewMessages } from "./pushed-new-messages";

export function NewMessagesPill({
  conversationId,
  rootId,
  viewerId,
  onShowLatest,
}: {
  conversationId: string;
  rootId: string | undefined;
  viewerId: string | undefined;
  onShowLatest: () => void;
}) {
  const count = usePushedNewMessages({ conversationId, rootId, viewerId });
  const label =
    count === 0
      ? m.conversation_back_to_bottom()
      : count === 1
        ? m.conversation_one_new_message()
        : m.conversation_new_messages({ count });
  return (
    <Button
      size="sm"
      color={count > 0 ? "primary" : "secondary"}
      iconTrailing={ArrowDown}
      onClick={onShowLatest}
      className="pointer-events-auto absolute bottom-full left-1/2 mb-2 -translate-x-1/2 rounded-full whitespace-nowrap shadow-md"
    >
      {label}
    </Button>
  );
}
