import { Button as AriaButton } from "react-aria-components";
import { ArrowLeft, ArrowUpRight, Bell01 as Bell, Check, XClose } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Tooltip } from "#src/components/base/tooltip/tooltip";
import { PaneHeader } from "#src/components/layout/pane-header";
import { m } from "#src/paraglide/messages";

export type ThreadFollow = { followed: boolean; onChange: (followed: boolean) => void };

export function ThreadPaneHeader({
  context,
  onScrollToTop,
  onClose,
  onViewInConversation,
  follow,
  action,
}: {
  context?: string;
  onScrollToTop?: () => void;
  onClose?: () => void;
  onViewInConversation?: () => void;
  follow?: ThreadFollow;
  action?: React.ReactNode;
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
  return (
    <PaneHeader
      className="px-4 md:px-6"
      barAlign="center"
      bar={
        <>
          {onViewInConversation && (
            <Button
              size="xs"
              color="link-gray"
              iconTrailing={ArrowUpRight}
              onPress={onViewInConversation}
            >
              {m.conversation_thread_original_message()}
            </Button>
          )}
          {follow && (
            <Button
              size="xs"
              color="secondary"
              className="ml-auto"
              iconLeading={follow.followed ? Check : Bell}
              aria-pressed={follow.followed}
              onPress={() => follow.onChange(!follow.followed)}
            >
              {follow.followed
                ? m.conversation_thread_following()
                : m.conversation_thread_follow_short()}
            </Button>
          )}
        </>
      }
    >
      <ButtonUtility
        icon={ArrowLeft}
        size="sm"
        color="tertiary"
        className="-ml-1.5 md:hidden"
        onClick={onClose}
        aria-label={m.conversation_thread_back()}
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
        <ButtonUtility
          icon={XClose}
          size="sm"
          color="tertiary"
          className="hidden md:inline-flex"
          tooltip={m.conversation_thread_close()}
          onClick={onClose}
        />
      </div>
    </PaneHeader>
  );
}
