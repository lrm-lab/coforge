import {
  useEffect,
  useRef,
  type ComponentType,
  type MouseEvent,
  type ReactNode,
  type RefObject,
  type SVGProps,
} from "react";
import { Activity, Grid01, MessageChatSquare } from "@untitledui/icons";

import type { TabHome } from "#src/components/layout/tab-home";
import { UnreadBadge, UnreadDot } from "#src/components/ui/unread-marker";
import { ActorAvatar } from "#src/features/avatars/actor-avatar";
import { useFootBarFold } from "#src/hooks/use-foot-bar-fold";
import { usePrefersReducedMotion } from "#src/hooks/use-prefers-reduced-motion";
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

type IconComponent = ComponentType<SVGProps<SVGSVGElement>>;

const TAB_ACTIVATE_KEYFRAMES: Keyframe[] = [
  { transform: "scale(1)" },
  { transform: "scale(0.88)" },
  { transform: "scale(1.08)" },
  { transform: "scale(1)" },
];

const TAB_ACTIVATE_TIMING: KeyframeAnimationOptions = {
  duration: 240,
  easing: "cubic-bezier(0.2, 0, 0, 1)",
};

function TabBarIcon({
  icon: Icon,
  active,
  reducedMotion,
}: {
  icon: IconComponent;
  active: boolean;
  reducedMotion: boolean;
}) {
  const wrapRef = useRef<HTMLSpanElement | null>(null);
  const prevActiveRef = useRef(active);

  useEffect(() => {
    const becameActive = active && !prevActiveRef.current;
    prevActiveRef.current = active;
    if (!becameActive || reducedMotion) return;
    const node = wrapRef.current;
    if (!node || typeof node.animate !== "function") return;
    const animation = node.animate(TAB_ACTIVATE_KEYFRAMES, TAB_ACTIVATE_TIMING);
    return () => animation.cancel();
  }, [active, reducedMotion]);

  return (
    <span ref={wrapRef} className="inline-flex size-full items-center justify-center">
      <Icon aria-hidden="true" className="size-full shrink-0" />
    </span>
  );
}

export function PhoneTabBar({
  current,
  chatHref,
  activityHref,
  activityUnread,
  base,
  user,
  scrollRootRef,
}: {
  current: TabHome;
  chatHref: string;
  activityHref: string;
  activityUnread: { count?: number; lit: boolean };
  base: string;
  user: { name: string; avatarUrl?: string | null };
  scrollRootRef: RefObject<HTMLElement | null>;
}) {
  const listRef = useRef<HTMLUListElement>(null);
  const reducedMotion = usePrefersReducedMotion();
  const { folded, open, onFocusCapture, onBlurCapture, scrollToTop } = useFootBarFold({
    scrollRootRef,
    activeKey: current,
  });
  const indicator = useSlidingIndicator(listRef, {
    activeKey: current,
    selector: '[aria-current="page"]',
    variant: "pill",
    paused: folded,
  });

  const tabs: Tab[] = [
    {
      key: "chat",
      label: m.navigation_chat_short(),
      href: chatHref,
      icon: (
        <TabBarIcon
          icon={MessageChatSquare}
          active={current === "chat"}
          reducedMotion={reducedMotion}
        />
      ),
    },
    {
      key: "activity",
      label: m.navigation_activity(),
      href: activityHref,
      icon: (
        <TabBarIcon icon={Activity} active={current === "activity"} reducedMotion={reducedMotion} />
      ),
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
      icon: (
        <TabBarIcon icon={Grid01} active={current === "workspace"} reducedMotion={reducedMotion} />
      ),
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
          className={cx("size-full", current === "me" ? "ring-2 ring-nav-fg-current" : undefined)}
        />
      ),
    },
  ];

  const handleTabClick = (event: MouseEvent<HTMLAnchorElement>, isCurrent: boolean) => {
    if (folded) {
      event.preventDefault();
      open();
      return;
    }
    if (isCurrent) {
      event.preventDefault();
      scrollToTop(reducedMotion);
    }
  };

  return (
    <nav
      aria-label={m.navigation_label()}
      data-folded={folded ? "true" : "false"}
      onFocusCapture={onFocusCapture}
      onBlurCapture={onBlurCapture}
      className="phone-foot-bar"
    >
      <div className="phone-foot-bar__shell">
        <ul ref={listRef} className="phone-foot-bar__list">
          {indicator.visible && (
            <li aria-hidden="true" role="presentation" className="contents">
              <span
                ref={indicator.indicatorRef}
                style={indicator.style}
                className="phone-foot-bar__indicator"
              />
            </li>
          )}
          {tabs.map(({ key, label, href, icon, badge, unreadText }) => {
            const isCurrent = key === current;
            const hiddenWhileFolded = folded && !isCurrent;
            return (
              <li
                key={key}
                data-current={isCurrent ? "true" : "false"}
                aria-hidden={hiddenWhileFolded || undefined}
                inert={hiddenWhileFolded || undefined}
                className="phone-foot-bar__item"
              >
                <a
                  href={href}
                  aria-current={isCurrent ? "page" : undefined}
                  tabIndex={hiddenWhileFolded ? -1 : undefined}
                  onClick={(event) => handleTabClick(event, isCurrent)}
                  className={cx(
                    "phone-foot-bar__link outline-focus-ring focus-visible:outline-2 focus-visible:-outline-offset-2",
                    isCurrent && !indicator.visible && !folded && "bg-nav-bg-current",
                  )}
                >
                  <span className="phone-foot-bar__icon">
                    {icon}
                    {badge}
                  </span>
                  <span className="phone-foot-bar__label truncate">{label}</span>
                  {unreadText && <span className="sr-only">, {unreadText}</span>}
                </a>
              </li>
            );
          })}
        </ul>
      </div>
    </nav>
  );
}
