import type { ReactNode } from "react";
import { Activity, Grid01, MessageChatSquare } from "@untitledui/icons";

import type { TabHome } from "#src/components/layout/tab-home";
import { UnreadBadge, UnreadDot } from "#src/components/ui/unread-marker";
import { ActorAvatar } from "#src/features/avatars/actor-avatar";
import { m } from "#src/paraglide/messages";
import { localizeHref } from "#src/paraglide/runtime";
import { cx } from "#src/utils/cx";

type Tab = {
  key: TabHome;
  label: string;
  href: string;
  /** What sits above the label: an icon, or the signed-in person's avatar. */
  icon: ReactNode;
  /** The Activity tab's unread marker, the one its sidebar row shows. */
  badge?: ReactNode;
  /** The unread count in words: the badge is hidden from assistive tech, so the link says it. */
  unreadText?: string;
};

/**
 * The phone's bottom tab bar: Chat, Activity, Workspace and Me, each an icon over a short label,
 * the current one in the navigation's current ink. `AppShell` mounts it only on a tab home
 * (`tabHomeOf`); it clears the home indicator with its own bottom padding.
 */
export function PhoneTabBar({
  current,
  chatHref,
  activityHref,
  activityUnread,
  base,
  user,
}: {
  current: TabHome | null;
  chatHref: string;
  activityHref: string;
  /** The Activity nav item's unread state: its count when the server counts, else whether the
   * dot is lit. */
  activityUnread: { count?: number; lit: boolean };
  /** The Workspace's path (`/w/<slug>`). */
  base: string;
  user: { name: string; avatarUrl?: string | null };
}) {
  const tabs: Tab[] = [
    {
      key: "chat",
      label: m.navigation_chat_short(),
      href: chatHref,
      icon: <MessageChatSquare aria-hidden="true" className="size-6" />,
    },
    {
      key: "activity",
      label: m.navigation_activity(),
      href: activityHref,
      icon: <Activity aria-hidden="true" className="size-6" />,
      // A small pill on the icon's corner, ringed in the bar's color, as on the collapsed rail, so
      // "99+" leaves the icon readable.
      badge: activityUnread.count ? (
        <UnreadBadge
          count={activityUnread.count}
          className="absolute -top-1.5 left-1/2 ml-1 h-4 min-w-4 px-1 ring-2 ring-sidebar"
        />
      ) : activityUnread.lit ? (
        <UnreadDot className="absolute top-0 right-0" />
      ) : undefined,
      unreadText: activityUnread.count
        ? m.conversation_thread_unread({ count: activityUnread.count })
        : undefined,
    },
    {
      key: "workspace",
      label: m.navigation_workspace_group(),
      href: localizeHref(`${base}/workspace`),
      icon: <Grid01 aria-hidden="true" className="size-6" />,
    },
    {
      key: "me",
      label: m.navigation_me(),
      href: localizeHref(`${base}/me`),
      icon: (
        <ActorAvatar
          presence={false}
          size="xs"
          name={user.name}
          alt=""
          src={user.avatarUrl}
          rounded
          className={current === "me" ? "ring-2 ring-nav-fg-current" : undefined}
        />
      ),
    },
  ];
  return (
    <nav
      aria-label={m.navigation_label()}
      className="shrink-0 border-t border-secondary bg-sidebar pb-safe-bottom lg:hidden"
    >
      <ul className="grid grid-cols-4">
        {tabs.map(({ key, label, href, icon, badge, unreadText }) => {
          const isCurrent = key === current;
          return (
            <li key={key}>
              <a
                href={href}
                aria-current={isCurrent ? "page" : undefined}
                className={cx(
                  "flex h-14 flex-col items-center justify-center gap-0.5 text-xs outline-focus-ring focus-visible:outline-2 focus-visible:-outline-offset-2",
                  isCurrent ? "font-semibold text-nav-fg-current" : "font-medium text-nav-fg",
                )}
              >
                <span className="relative flex">
                  {icon}
                  {badge}
                </span>
                <span className="max-w-full truncate px-1">{label}</span>
                {unreadText && <span className="sr-only">, {unreadText}</span>}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
