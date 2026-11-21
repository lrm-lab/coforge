import { useRef, type ReactNode } from "react";
import { Activity, Grid01, MessageChatSquare } from "@untitledui/icons";

import type { TabHome } from "#src/components/layout/tab-home";
import { UnreadBadge, UnreadDot } from "#src/components/ui/unread-marker";
import { ActorAvatar } from "#src/features/avatars/actor-avatar";
import { useSlidingIndicator } from "#src/hooks/use-sliding-indicator";
import { m } from "#src/paraglide/messages";
import { localizeHref } from "#src/paraglide/runtime";
import { cx } from "#src/utils/cx";

type Tab = {
  key: TabHome;
  label: string;
  href: string;
  icon: ReactNode;
  badge?: ReactNode;
  unreadText?: string;
};

export function PhoneTabBar({
  current,
  chatHref,
  activityHref,
  activityUnread,
  base,
  user,
}: {
  current: TabHome;
  chatHref: string;
  activityHref: string;
  activityUnread: { count?: number; lit: boolean };
  base: string;
  user: { name: string; avatarUrl?: string | null };
}) {
  const listRef = useRef<HTMLUListElement>(null);
  const indicator = useSlidingIndicator(listRef, {
    activeKey: current,
    selector: '[aria-current="page"]',
    variant: "pill",
  });
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
      badge: activityUnread.count ? (
        <UnreadBadge
          count={activityUnread.count}
          className={cx(
            "absolute -top-1.5 left-1/2 ml-1 h-4 min-w-4 px-1 ring-2",
            current === "activity" ? "ring-nav-bg-current" : "ring-sidebar",
          )}
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
      className="shrink-0 border-t border-secondary bg-sidebar pb-safe-bottom"
    >
      <ul ref={listRef} className="relative grid grid-cols-4 px-1.5 py-1">
        {indicator.visible && (
          <span
            ref={indicator.indicatorRef}
            aria-hidden="true"
            style={indicator.style}
            className="pointer-events-none absolute top-0 left-0 z-0 rounded-xl bg-nav-bg-current will-change-transform"
          />
        )}
        {tabs.map(({ key, label, href, icon, badge, unreadText }) => {
          const isCurrent = key === current;
          return (
            <li key={key}>
              <a
                href={href}
                aria-current={isCurrent ? "page" : undefined}
                className={cx(
                  "relative z-10 flex h-12 flex-col items-center justify-center gap-0.5 rounded-xl text-xs outline-focus-ring transition-colors duration-150 focus-visible:outline-2 focus-visible:-outline-offset-2",
                  isCurrent
                    ? cx(
                        "font-semibold text-nav-fg-current",
                        !indicator.visible && "bg-nav-bg-current",
                      )
                    : "font-medium text-nav-fg",
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
