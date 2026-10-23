import { useState, type ReactNode } from "react";
import { Link, useRouter } from "@tanstack/react-router";
import { Link as AriaLink } from "react-aria-components";

import { UnreadBadge, UnreadDot } from "#src/components/ui/unread-marker";
import { cx } from "#src/utils/cx";
import { m } from "#src/paraglide/messages";
import { MentionBadge } from "./mention-badge";
import { useCloseConversationList } from "./conversation-navigation";
import { conversationRoute, type ConversationTarget } from "./last-conversation";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { createRowHover, RowHoverContext } from "./row-hover";

/** The row's accessible name: the conversation it names, plus its unread count when it has one,
 * and the mention when its "@" badge shows. A DM row's time and preview stay visible but are not
 * part of the name, so a read DM is named by `label` alone, as an unread one is. */
function rowLabel(
  unreadCount: number | undefined,
  label: string,
  mentioned: boolean | undefined,
): string | undefined {
  if (!unreadCount) return undefined;
  if (mentioned) return m.channel_unread_mention_accessible({ channel: label, count: unreadCount });
  return m.channel_unread_accessible({ channel: label, count: unreadCount });
}

/** A conversation row's second layout: the last message's time beside the name, and its sender-
 * prefixed preview under it, with the mention and unread markers at the end of that line. */
export type LastMessageLines = {
  /** The clock or short date of the last message; `null` while the conversation has no message. */
  time: string | null;
  /** The preview line (`channelPreviewLine` for a channel); `null` while there is no message, so
   * the row shows the name only. */
  preview: string | null;
  /** The "@" badge shows: the viewer is mentioned and the mention is unread (`channelMentionShown`). */
  mentioned?: boolean;
};

/**
 * A local row (not NavItemBase — its `icon` slot hardcodes size-5 and can't take an Avatar). The
 * icon sets its own column width: a 48px avatar (a DM's avatar, or a channel's collage with one or
 * more members) in a two-line row (`lastMessage` given), and a 16px-wide icon for Saved and for a
 * channel with no member. A two-line row has a second line with the last message's preview under
 * its name. Both share the text start and the current/hover treatment. A channel's or direct
 * message's selected row is a card (`card`). A face that reacts to the pointer over the whole row
 * reads it with `useRowHovered`.
 */
export function ConversationRow({
  target,
  current,
  card,
  pinned,
  icon,
  muted,
  unreadCount,
  count,
  label,
  lastMessage,
  children,
}: {
  target: ConversationTarget;
  current?: boolean;
  /** The selected row is a bordered card, as a channel's and a direct message's are. */
  card?: boolean;
  /** The member pinned this row: its name draws the sidebar foreground colour (design spec),
   * darker than an unpinned row's, until it is selected or muted. */
  pinned?: boolean;
  icon: ReactNode;
  muted?: boolean;
  unreadCount?: number;
  /** A plain total shown at the row's end (the Saved entry's bookmark count), not an unread
   * signal: muted, and absent at zero. `label` is how the row's accessible name says it. */
  count?: { value: number; label: string };
  /** The row's own name, so an unread row keeps its accessible name instead of replacing it. */
  label: string;
  /** A two-line layout; absent for the Saved entry and every other single-line row. */
  lastMessage?: LastMessageLines;
  children: ReactNode;
}) {
  const closeList = useCloseConversationList();
  const router = useRouter();
  const workspaceSlug = useWorkspaceSlug();
  const [hover] = useState(createRowHover);
  const route = conversationRoute(target, workspaceSlug);
  return (
    // The row is a React Aria link so the conversation menu's `MenuTrigger trigger="contextMenu"`
    // can use it as its trigger; `render` hands the element to TanStack's `Link`, which owns
    // navigation (React Aria's documented client-side routing pattern, react-aria.adobe.com/Link).
    <AriaLink
      href={router.buildLocation(route).href}
      // `href` is always set, so React Aria renders an `<a>`; the check narrows the props type.
      render={(props) => ("href" in props ? <Link {...props} {...route} /> : <span {...props} />)}
      aria-current={current ? "page" : undefined}
      // Lets the section list measure its bottom space from a bordered card's avatar.
      data-row-card={card || undefined}
      aria-label={
        rowLabel(unreadCount, label, lastMessage?.mentioned) ??
        (count ? `${label}, ${count.label}` : lastMessage ? label : undefined)
      }
      // On mobile the list is a separate pane; choosing a row reveals the conversation even when
      // the URL is unchanged (re-opening the channel already in the address bar), which the
      // pathname-based reset in `ConversationNavigation` cannot see.
      onPress={closeList}
      onHoverChange={hover.set}
      className={cx(
        // `-webkit-user-drag: none`: a sidebar drag moves the row (see `directory-drag.tsx`), never
        // the browser's own link drag.
        "flex w-full cursor-pointer items-center p-2 outline-focus-ring transition duration-100 ease-linear select-none [-webkit-user-drag:none] focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-offset-2",
        card ? "rounded-xl border" : "rounded-md",
        // A single-line row (Saved) lines up with a section title: its 16px icon on the chevron's
        // x and its text on the title's (`gap-1.5`, as a non-collapsible title uses).
        lastMessage ? "gap-2" : "max-h-9 gap-1.5",
        current ? (card ? "bg-chat-selected-bg" : "bg-sidebar-accent") : "hover:bg-primary_hover",
        card && (current ? "border-chat-selected-border" : "border-transparent"),
      )}
    >
      <RowHoverContext.Provider value={hover}>
        {lastMessage ? (
          <span className="flex shrink-0 items-center justify-center">{icon}</span>
        ) : (
          <span className="flex h-5 w-4 shrink-0 items-center justify-center">{icon}</span>
        )}
      </RowHoverContext.Provider>
      {lastMessage ? (
        <span className="flex min-w-0 flex-1 flex-col justify-center">
          <span className="flex min-w-0 items-center gap-2">
            <span
              className={cx(
                "min-w-0 flex-1 truncate text-sm font-medium",
                current
                  ? "text-brand-secondary"
                  : muted
                    ? "text-tertiary"
                    : pinned
                      ? "text-sidebar-fg"
                      : "text-secondary",
              )}
            >
              {children}
            </span>
            {lastMessage.time ? (
              <span className="shrink-0 text-xs text-quaternary tabular-nums">
                {lastMessage.time}
              </span>
            ) : null}
          </span>
          {lastMessage.preview || unreadCount || lastMessage.mentioned ? (
            <span className="flex min-w-0 items-center gap-2">
              {lastMessage.preview ? (
                <span className="min-w-0 flex-1 truncate text-sm text-tertiary">
                  {lastMessage.preview}
                </span>
              ) : (
                <span className="flex-1" />
              )}
              {lastMessage.mentioned ? <MentionBadge /> : null}
              {unreadCount ? muted ? <UnreadDot /> : <UnreadBadge count={unreadCount} /> : null}
            </span>
          ) : null}
        </span>
      ) : (
        <span
          className={cx(
            // The section titles' size, weight and colour, so Saved reads as one of them.
            "min-w-0 flex-1 truncate text-sm font-medium",
            current ? "text-brand-secondary" : muted ? "text-tertiary" : "text-primary",
          )}
        >
          {children}
        </span>
      )}
      {!lastMessage && unreadCount ? (
        muted ? (
          <UnreadDot />
        ) : (
          <UnreadBadge count={unreadCount} />
        )
      ) : null}
      {count ? (
        <span aria-hidden="true" className="shrink-0 text-xs text-quaternary tabular-nums">
          {count.value}
        </span>
      ) : null}
    </AriaLink>
  );
}
