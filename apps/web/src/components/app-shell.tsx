import { memo, useEffect, useMemo, useRef, useState, type FC } from "react";
import { useRouter, useRouterState } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  CodeBrowser,
  File02 as FileText,
  Folder,
  MessageChatSquare,
  Monitor01 as Monitor,
  Stars01,
  Users01 as Users,
} from "@untitledui/icons";

import type { NavItemType } from "#src/components/application/app-navigation/config";
import { SidebarRail } from "#src/components/layout/sidebar/sidebar-rail";
import { SidebarExpanded } from "#src/components/layout/sidebar/sidebar-expanded";
import { SidebarShell } from "#src/components/layout/sidebar/sidebar-shell";
import { UserMenuCard, UserRow } from "#src/components/layout/sidebar/user-menu-card";
import {
  ChatListOpenContext,
  ChatListShownContext,
  PhoneShellContext,
  type PhoneShell,
} from "#src/components/layout/phone-shell";
import { PhoneTabBar } from "#src/components/layout/phone-tab-bar";
import { ShellLinks } from "#src/components/layout/shell-links";
import { useIsStandalonePage } from "#src/components/layout/standalone-page";
import { CHAT_SECTIONS, sectionOf, tabHomeOf } from "#src/components/layout/tab-home";
import { UnreadBadge, UnreadDot } from "#src/components/ui/unread-marker";
import { rememberRecordsLastPath, recordsNavHref } from "#src/features/records/records-last-path";
import {
  activityNavAttentionQuery,
  activityNavAttentionRealtime,
} from "#src/features/inbox/activity-inbox-queries";
import { useActivityInboxRealtime } from "#src/features/inbox/use-activity-inbox-realtime";
import { NotificationBell } from "#src/features/usage-limits/notification-bell";
import { SystemNotificationsProvider } from "#src/features/usage-limits/system-notifications-provider";
import {
  WhatsNewAnnouncer,
  WhatsNewRailButton,
  WhatsNewRow,
} from "#src/features/whats-new/whats-new-entry";
import {
  WorkspaceSwitcher,
  type WorkspaceOption,
} from "#src/features/workspaces/workspace-switcher";
import type { CreateWorkspaceInput } from "#src/features/workspaces/create-workspace-form";
import { useReportActivityUnread, useWorkspaceTabTitle } from "#src/lib/browser-tab";
import { m } from "#src/paraglide/messages";
import { localizeHref } from "#src/paraglide/runtime";
import { useAppHeight } from "#src/hooks/use-app-height";
import { useBreakpoint } from "#src/hooks/use-breakpoint";
import { useLatestCallback } from "#src/hooks/use-latest-callback";
import { SearchField, SearchRailButton } from "#src/features/search/search-field";
import { SidebarToggle } from "#src/components/layout/sidebar/sidebar-toggle";
import { workspacePath } from "#src/features/workspaces/workspace-url";
import { cx } from "#src/utils/cx";
import { KeyboardShortcutsHost } from "#src/features/shortcuts/keyboard-shortcuts-host";

export type AppUser = {
  id: string;
  name: string;
  email: string | null;
  avatarUrl?: string | null;
};

function useActivityAttention(user: AppUser, workspaceId: string) {
  const queryClient = useQueryClient();
  const { onMessage, onActivity, onAttention, onSubscribed } = useMemo(
    () => activityNavAttentionRealtime(queryClient, user.id, workspaceId),
    [queryClient, user.id, workspaceId],
  );
  useActivityInboxRealtime({
    userId: user.id,
    workspaceId,
    onMessage,
    onActivity,
    onAttention,
    onSubscribed,
  });
  const query = useQuery(activityNavAttentionQuery(workspaceId));
  return { hasUnread: query.data?.hasUnread ?? false, unreadCount: query.data?.unreadCount };
}

function useNavItems(
  base: string,
  recordsPreview: boolean,
  workspaceId: string,
  aiWorkbench: boolean,
  activity: { hasUnread: boolean; unreadCount?: number },
): (NavItemType & {
  icon: FC<{ className?: string }>;
  unreadCount?: number;
  bareHref: string;
  sections: readonly string[];
  tab?: "chat" | "activity";
})[] {
  const unreadCount =
    activity.unreadCount && activity.unreadCount > 0 ? activity.unreadCount : undefined;
  const { hasUnread } = activity;
  const recordsHref = recordsNavHref(workspaceId);
  return useMemo(() => {
    const recordsDot = recordsPreview ? <UnreadDot className="ms-auto" /> : undefined;
    const activityBadge =
      unreadCount !== undefined ? (
        <>
          <UnreadBadge count={unreadCount} />
          <span className="sr-only">{m.conversation_thread_unread({ count: unreadCount })}</span>
        </>
      ) : hasUnread ? (
        <UnreadDot className="ms-auto" />
      ) : undefined;
    const item = (section: string) => ({
      bareHref: `${base}/${section}`,
      href: localizeHref(`${base}/${section}`),
      sections: [section],
    });
    return [
      {
        label: m.navigation_chat(),
        bareHref: base,
        href: localizeHref(base),
        sections: CHAT_SECTIONS,
        icon: MessageChatSquare,
        tab: "chat" as const,
      },
      {
        label: m.navigation_activity(),
        ...item("activity"),
        icon: Activity,
        badge: activityBadge,
        unreadCount,
        tab: "activity" as const,
      },
      ...(aiWorkbench ? [{ label: m.pi_chat_title(), ...item("pi-chat"), icon: Stars01 }] : []),
      { label: m.projects_title(), ...item("projects"), icon: Folder },
      {
        label: m.navigation_artifacts(),
        ...item("artifacts"),
        sections: ["artifacts", "artifact"],
        icon: CodeBrowser,
      },
      {
        label: m.navigation_agents(),
        ...item("members"),
        sections: ["members", "agent"],
        icon: Users,
      },
      {
        label: m.navigation_records(),
        bareHref: `${base}/records`,
        href: localizeHref(`${base}${recordsHref}`),
        sections: ["records"],
        icon: FileText,
        badge: recordsDot,
      },
      {
        label: m.navigation_computers(),
        ...item("computers"),
        sections: ["computers", "computer"],
        icon: Monitor,
      },
    ];
  }, [base, recordsPreview, aiWorkbench, unreadCount, hasUnread, recordsHref]);
}

const MemoSidebarExpanded = memo(SidebarExpanded);
const MemoSidebarRail = memo(SidebarRail);
const MemoPhoneTabBar = memo(PhoneTabBar);
const SEARCH_FIELD = <SearchField />;
const SIDEBAR_TOGGLE_COLLAPSE = <SidebarToggle />;
const SIDEBAR_TOGGLE_EXPAND = <SidebarToggle expand />;
const SEARCH_RAIL_BUTTON = <SearchRailButton />;

type AppShellProps = {
  aiWorkbench?: boolean;
  canSeeUsageLimits?: boolean;
  user: AppUser;
  workspaces: WorkspaceOption[];
  currentWorkspace: WorkspaceOption;
  onSelectWorkspace?: (slug: string) => Promise<void> | void;
  onCreateWorkspace?: (input: CreateWorkspaceInput) => Promise<void>;
  onSignOut: () => Promise<void> | void;
  recordsPreview?: boolean;
  children: React.ReactNode;
};

export function AppShell(props: AppShellProps) {
  useAppHeight();
  const standalone = useIsStandalonePage();
  const [chromeMounted, setChromeMounted] = useState(!standalone);
  if (!standalone && !chromeMounted) setChromeMounted(true);
  useWorkspaceTabTitle(props.currentWorkspace.name);
  return (
    <SystemNotificationsProvider
      viewerId={props.user.id}
      enabled={props.canSeeUsageLimits ?? false}
    >
      <WhatsNewAnnouncer base={workspacePath(props.currentWorkspace.slug)} />
      <KeyboardShortcutsHost workspaceSlug={props.currentWorkspace.slug}>
        {chromeMounted ? (
          <WorkspaceChrome {...props} standalone={standalone} />
        ) : (
          <div className="flex h-[var(--app-height,100dvh)] flex-col bg-primary pt-safe-top pr-safe-right pb-safe-bottom pl-safe-left font-body antialiased">
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">{props.children}</div>
          </div>
        )}
      </KeyboardShortcutsHost>
    </SystemNotificationsProvider>
  );
}

function WorkspaceChrome({
  user,
  workspaces,
  currentWorkspace,
  onSelectWorkspace,
  onCreateWorkspace,
  onSignOut,
  children,
  recordsPreview = false,
  aiWorkbench = false,
  standalone = false,
}: AppShellProps & { standalone?: boolean }) {
  const router = useRouter();
  const section = useRouterState({
    select: (state) => {
      const current = sectionOf(state.location.pathname);
      return current && CHAT_SECTIONS.includes(current) ? "channel" : current;
    },
  });
  const itemOpen = useRouterState({
    select: (state) =>
      sectionOf(state.location.pathname) === "activity" &&
      (state.matches.at(-1)?.search as { open?: unknown } | undefined)?.open !== undefined,
  });
  const workspaceId = currentWorkspace.id;
  const base = workspacePath(currentWorkspace.slug);
  useEffect(() => {
    const remember = () => {
      const { pathname, searchStr } = router.state.location;
      if (!pathname.startsWith(`${base}/records`)) return;
      const query = !searchStr ? "" : searchStr.startsWith("?") ? searchStr : `?${searchStr}`;
      rememberRecordsLastPath(workspaceId, `${pathname.slice(base.length)}${query}`);
    };
    remember();
    return router.subscribe("onResolved", remember);
  }, [router, workspaceId, base]);
  const activityAttention = useActivityAttention(user, workspaceId);
  useReportActivityUnread(activityAttention.hasUnread, activityAttention.unreadCount);
  const navItems = useNavItems(base, recordsPreview, workspaceId, aiWorkbench, activityAttention);
  const defaultRail = CHAT_SECTIONS.includes(section);
  const [chatListOpen, setChatListOpen] = useState(false);
  const tabHome = tabHomeOf({ section, itemOpen, chatListOpen });
  const phone = !useBreakpoint("lg");
  const activeUrl = navItems.find((item) => item.sections.includes(section))?.href;
  const chatItem = navItems.find((item) => item.tab === "chat");
  const activityItem = navItems.find((item) => item.tab === "activity");
  const chatHref = chatItem?.href;
  const activityHref = activityItem?.href;
  const tabBar = !standalone && phone && chatHref && activityHref ? tabHome : null;
  const selectWorkspace = useLatestCallback(onSelectWorkspace);
  const createWorkspace = useLatestCallback(onCreateWorkspace);
  const signOut = useLatestCallback(onSignOut);
  const contentScrollRootRef = useRef<HTMLDivElement>(null);
  const { name, email, avatarUrl } = user;
  const phoneShell = useMemo<PhoneShell>(
    () => ({
      workspaceSwitcher: (
        <WorkspaceSwitcher
          workspaces={workspaces}
          current={currentWorkspace}
          onSelect={selectWorkspace}
          onCreate={createWorkspace}
          markOnly
        />
      ),
      workspaceItems: navItems.filter(
        (item): item is typeof item & { href: string } => !item.tab && item.href !== undefined,
      ),
      user: { name, email, avatarUrl },
      onSignOut: signOut,
    }),
    [
      workspaces,
      currentWorkspace,
      selectWorkspace,
      createWorkspace,
      navItems,
      name,
      email,
      avatarUrl,
      signOut,
    ],
  );
  const expandedHeader = useMemo(
    () => (
      <>
        <div className="flex min-w-0 flex-1">
          <WorkspaceSwitcher
            workspaces={workspaces}
            current={currentWorkspace}
            onSelect={selectWorkspace}
            onCreate={createWorkspace}
          />
        </div>
        {SIDEBAR_TOGGLE_COLLAPSE}
      </>
    ),
    [workspaces, currentWorkspace, selectWorkspace, createWorkspace],
  );
  const expandedFooter = useMemo(
    () => (
      <>
        <WhatsNewRow base={base} />
        <UserRow
          base={base}
          user={user}
          onSignOut={signOut}
          workspaceSlug={currentWorkspace.slug}
        />
      </>
    ),
    [base, user, signOut, currentWorkspace.slug],
  );
  const railHeader = useMemo(
    () => (
      <>
        {SIDEBAR_TOGGLE_EXPAND}
        {phoneShell.workspaceSwitcher}
        {SEARCH_RAIL_BUTTON}
      </>
    ),
    [phoneShell.workspaceSwitcher],
  );
  const railFooter = useMemo(
    () => (
      <>
        <WhatsNewRailButton base={base} />
        <NotificationBell workspaceSlug={currentWorkspace.slug} badgeRing="ring-sidebar" />
        <UserMenuCard compact base={base} user={user} onSignOut={signOut} />
      </>
    ),
    [base, currentWorkspace.slug, user, signOut],
  );
  const activityUnreadCount = activityItem?.unreadCount;
  const activityUnreadLit = Boolean(activityItem?.badge);
  const activityUnread = useMemo(
    () => ({
      count: activityUnreadCount,
      lit: activityUnreadLit,
    }),
    [activityUnreadCount, activityUnreadLit],
  );

  const mainArea = (
    <div
      ref={contentScrollRootRef}
      data-phone-tab-bar={tabBar ? "" : undefined}
      className={cx("flex min-h-0 min-w-0 flex-1 flex-col", !standalone && "lg:p-2 lg:ps-0")}
    >
      <div
        className={cx(
          "flex min-h-0 min-w-0 flex-1 flex-col bg-primary",
          !standalone &&
            "lg:overflow-hidden lg:rounded-xl lg:has-[[data-panel-cards]]:overflow-visible lg:has-[[data-panel-cards]]:rounded-none lg:has-[[data-panel-cards]]:bg-transparent",
        )}
      >
        <ChatListShownContext value={phone && chatListOpen}>{children}</ChatListShownContext>
      </div>
    </div>
  );

  return (
    <PhoneShellContext value={phoneShell}>
      <ChatListOpenContext value={setChatListOpen}>
        <div
          data-sidebar-default-rail={defaultRail ? "" : undefined}
          data-phone-page-scroll={tabBar ? "" : undefined}
          className={cx(
            "flex flex-col bg-primary pt-safe-top pr-safe-right pl-safe-left font-body antialiased",
            tabBar ? "min-h-dvh" : "h-[var(--app-height,100dvh)]",
            !standalone && "lg:h-[var(--app-height,100dvh)] lg:bg-sidebar",
            !tabBar && "pb-safe-bottom",
          )}
        >
          <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
            {!standalone && !phone ? (
              <SidebarShell
                defaultRail={defaultRail}
                expanded={
                  <ShellLinks>
                    <MemoSidebarExpanded
                      activeUrl={activeUrl}
                      items={navItems}
                      header={expandedHeader}
                      search={SEARCH_FIELD}
                      footer={expandedFooter}
                    />
                  </ShellLinks>
                }
                rail={
                  <ShellLinks>
                    <MemoSidebarRail
                      activeUrl={activeUrl}
                      items={navItems}
                      header={railHeader}
                      footer={railFooter}
                    />
                  </ShellLinks>
                }
              >
                {mainArea}
              </SidebarShell>
            ) : (
              mainArea
            )}
          </div>
          {tabBar && chatHref && activityHref && (
            <ShellLinks>
              <MemoPhoneTabBar
                current={tabBar}
                chatHref={chatHref}
                activityHref={activityHref}
                activityUnread={activityUnread}
                base={base}
                user={user}
                scrollRootRef={contentScrollRootRef}
              />
            </ShellLinks>
          )}
        </div>
      </ChatListOpenContext>
    </PhoneShellContext>
  );
}
