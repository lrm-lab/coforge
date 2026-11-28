import { Button as AriaButton } from "react-aria-components";
import {
  ArrowLeft,
  Bell01 as Bell,
  BellOff01 as BellOff,
  DotsVertical,
  Mail01,
  MarkerPin01,
  XClose,
} from "@untitledui/icons";

import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { PANE_HEADER_ATTR, PANE_HEADER_CLASS } from "#src/components/layout/pane-header";
import { Tooltip } from "#src/components/base/tooltip/tooltip";
import { m } from "#src/paraglide/messages";
import { cx } from "#src/utils/cx";
import { ConversationFocusButton } from "./conversation-focus-button";

export type ThreadFollow = { followed: boolean; onChange: (followed: boolean) => void };

export function ThreadPaneHeader({
  context,
  onScrollToTop,
  onClose,
  onViewInConversation,
  onMarkUnread,
  follow,
  action,
  showBack,
}: {
  context?: string;
  onScrollToTop?: () => void;
  onClose?: () => void;
  onViewInConversation?: () => void;
  onMarkUnread?: () => void;
  follow?: ThreadFollow;
  action?: React.ReactNode;
  showBack?: boolean;
}) {
  const title = (
    <>
      {m.conversation_thread()}
      {context && (
        <span className="font-normal text-tertiary">
          {m.conversation_thread_title_context({ name: context })}
        </span>
      )}
    </>
  );
  const backClass =
    showBack === true ? "-ml-1.5" : showBack === false ? "hidden" : "-ml-1.5 md:hidden";
  const closeClass =
    showBack === true ? "hidden" : showBack === false ? "inline-flex" : "hidden md:inline-flex";
  return (
    <header {...PANE_HEADER_ATTR} className={cx(PANE_HEADER_CLASS, "gap-2 px-4 md:px-6")}>
      <ButtonUtility
        icon={ArrowLeft}
        size="sm"
        color="tertiary"
        className={backClass}
        onClick={onClose}
        tooltip={m.conversation_thread_back()}
      />
      <h2 className="flex min-w-0 flex-1 text-md font-semibold">
        {onScrollToTop ? (
          <Tooltip title={m.conversation_thread_scroll_to_top()} placement="bottom start">
            <AriaButton
              onPress={onScrollToTop}
              className="min-w-0 cursor-pointer truncate rounded-sm text-left outline-focus-ring focus-visible:outline-2 focus-visible:outline-offset-2"
            >
              {title}
            </AriaButton>
          </Tooltip>
        ) : (
          <span className="min-w-0 truncate">{title}</span>
        )}
      </h2>
      <div className="-mr-1.5 flex shrink-0 items-center gap-1">
        {action}
        <ConversationFocusButton panel="thread" />
        {(onViewInConversation || onMarkUnread || follow) && (
          <Dropdown.Root>
            <ButtonUtility
              icon={DotsVertical}
              size="sm"
              color="tertiary"
              tooltip={m.conversation_thread_actions()}
            />
            <Dropdown.Popover placement="bottom end" className="w-52">
              <Dropdown.Menu aria-label={m.conversation_thread_actions()}>
                {onViewInConversation && (
                  <Dropdown.Item
                    id="view-in-conversation"
                    icon={MarkerPin01}
                    label={m.conversation_thread_view_in_channel()}
                    onAction={onViewInConversation}
                  />
                )}
                {onMarkUnread && (
                  <Dropdown.Item
                    id="mark-unread"
                    icon={Mail01}
                    label={m.conversation_thread_mark_unread()}
                    onAction={onMarkUnread}
                  />
                )}
                {follow && (
                  <Dropdown.Item
                    id="follow"
                    icon={follow.followed ? BellOff : Bell}
                    label={
                      follow.followed
                        ? m.conversation_thread_unfollow()
                        : m.conversation_thread_follow()
                    }
                    onAction={() => follow.onChange(!follow.followed)}
                  />
                )}
              </Dropdown.Menu>
            </Dropdown.Popover>
          </Dropdown.Root>
        )}
        <ButtonUtility
          icon={XClose}
          size="sm"
          color="tertiary"
          className={closeClass}
          tooltip={m.conversation_thread_close()}
          onClick={onClose}
        />
      </div>
    </header>
  );
}
