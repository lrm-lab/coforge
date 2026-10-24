import { ArrowDown } from "@untitledui/icons";

import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { UnreadDot } from "#src/components/ui/unread-marker";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";

import { OwnMessagesMenu, type OwnMessagesIndex } from "./own-messages-menu";

/**
 * The pane's jump group at the composer's top-right corner: the viewer's own messages, and the way
 * back to the newest one. Following the newest with nothing of the viewer's, it is not there.
 */
export function MessageNavigationGroup({
  index,
  followingLatest,
  newMessageCount,
  onShowMessage,
  onShowLatest,
  formatBody,
}: {
  index: OwnMessagesIndex;
  followingLatest: boolean;
  newMessageCount: number;
  onShowMessage: (messageId: string) => void;
  onShowLatest: () => void;
  formatBody: (body: string) => string;
}) {
  if (index.messages.length === 0 && followingLatest) return null;
  return (
    <div
      role="group"
      aria-label={m.conversation_message_navigation()}
      className={cn(
        "pointer-events-auto mb-3 ml-auto inline-flex shrink-0 items-center gap-0.5 rounded-full border border-secondary bg-primary p-0.5 shadow-xs transition-opacity",
        followingLatest &&
          !index.open &&
          "pointer-events-none opacity-0 group-hover/history:pointer-events-auto group-hover/history:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100 [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100",
      )}
    >
      {index.messages.length > 0 && (
        <OwnMessagesMenu
          messages={index.messages}
          loading={index.loading}
          open={index.open}
          onOpenChange={index.setOpen}
          menuRef={index.menuRef}
          onLoadOlder={index.loadOlder}
          onSelect={onShowMessage}
          formatBody={formatBody}
        />
      )}
      {index.messages.length > 0 && !followingLatest && (
        <span aria-hidden="true" className="h-4 w-px bg-secondary" />
      )}
      {!followingLatest && (
        <span className="relative">
          <ButtonUtility
            icon={ArrowDown}
            size="xs"
            color="tertiary"
            onClick={onShowLatest}
            aria-label={
              newMessageCount === 1
                ? m.conversation_one_new_message()
                : newMessageCount > 1
                  ? m.conversation_new_messages({ count: newMessageCount })
                  : m.conversation_back_to_bottom()
            }
            className="rounded-full"
          />
          {newMessageCount > 0 && (
            <UnreadDot className="absolute -top-1 -right-1 size-2.5 border border-primary" />
          )}
        </span>
      )}
    </div>
  );
}
