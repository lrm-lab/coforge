import { useEffect, useMemo, useState, type FC } from "react";
import { useRouterState } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  BookOpen01,
  CodeBrowser,
  File02 as FileText,
  Folder,
  Keyboard01,
  LogOut01 as LogOut,
  MessageChatSquare,
  Monitor01 as Monitor,
  Settings01,
  Stars01,
  Users01 as Users,
} from "@untitledui/icons";
import { Button as AriaButton } from "react-aria-components";

import type { NavItemType } from "#src/components/application/app-navigation/config";
import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { SidebarRail } from "#src/components/layout/sidebar/sidebar-rail";
import { SidebarExpanded } from "#src/components/layout/sidebar/sidebar-expanded";
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
import { ActorAvatar } from "#src/features/avatars/actor-avatar";
import { cx } from "#src/utils/cx";
import {
  KeyboardShortcutsHost,
  useOpenKeyboardShortcuts,
} from "#src/features/shortcuts/keyboard-shortcuts-host";
import { HOTKEYS, hotkeyLabel } from "#src/lib/hotkeys";
import { isApplePlatform } from "#src/lib/platform";

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
  sections?: readonly string[];
  tab?: "chat" | "activity";
})[] {
  const unreadCount =
    activity.unreadCount && activity.unreadCount > 0 ? activity.unreadCount : undefined;
  const { hasUnread } = activity;
  const recordsHref = recordsNavHref(workspaceId);
  return useMemo(() => {
    const recordsDot = recordsPreview ? <UnreadDot className="ml-auto" /> : undefined;
    const activityBadge =
      unreadCount !== undefined ? (
        <>
          <UnreadBadge count={unreadCount} />
          <span className="sr-only">{m.conversation_thread_unread({ count: unreadCount })}</span>
        </>
      ) : hasUnread ? (
        <UnreadDot className="ml-auto" />
      ) : undefined;
    const item = (section: string) => ({
      bareHref: `${base}/${section}`,
      href: localizeHref(`${base}/${section}`),
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
      { label: m.memory_title(), ...item("memory"), icon: BookOpen01 },
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
      <WhatsNewAnnouncer />
      <KeyboardShortcutsHost>
        {chromeMounted ? (
          <WorkspaceChrome {...props} standalone={standalone} />
        ) : (
          <div className="flex h-[var(--app-height,100svh)] flex-col bg-primary pt-safe-top pr-safe-right pb-safe-bottom pl-safe-left font-body antialiased">
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
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const searchStr = useRouterState({
    select: (state) => state.location.searchStr,
  });
  const itemOpen = useRouterState({
    select: (state) =>
      (state.matches.at(-1)?.search as { open?: unknown } | undefined)?.open !== undefined,
  });
  const workspaceId = currentWorkspace.id;
  const base = workspacePath(currentWorkspace.slug);
  useEffect(() => {
    if (!pathname.startsWith(`${base}/records`)) return;
    const query = !searchStr ? "" : searchStr.startsWith("?") ? searchStr : `?${searchStr}`;
    rememberRecordsLastPath(workspaceId, `${pathname.slice(base.length)}${query}`);
  }, [workspaceId, base, pathname, searchStr]);
  const activityAttention = useActivityAttention(user, workspaceId);
  useReportActivityUnread(activityAttention.hasUnread, activityAttention.unreadCount);
  const navItems = useNavItems(base, recordsPreview, workspaceId, aiWorkbench, activityAttention);
  const section = sectionOf(pathname);
  const [chatListOpen, setChatListOpen] = useState(false);
  const tabHome = tabHomeOf({ section, itemOpen, chatListOpen });
  const phone = !useBreakpoint("lg");
  const activeUrl = navItems.find((item) =>
    item.sections
      ? item.sections.includes(section)
      : pathname === item.bareHref || pathname.startsWith(`${item.bareHref}/`),
  )?.href;
  const workspaceSwitcher = (
    <WorkspaceSwitcher
      workspaces={workspaces}
      current={currentWorkspace}
      onSelect={onSelectWorkspace}
      onCreate={onCreateWorkspace}
    />
  );
  const chatItem = navItems.find((item) => item.tab === "chat");
  const activityItem = navItems.find((item) => item.tab === "activity");
  const chatHref = chatItem?.href;
  const activityHref = activityItem?.href;
  const tabBar = !standalone && phone && chatHref && activityHref ? tabHome : null;
  const selectWorkspace = useLatestCallback(onSelectWorkspace);
  const createWorkspace = useLatestCallback(onCreateWorkspace);
  const signOut = useLatestCallback(onSignOut);
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

  return (
    <PhoneShellContext value={phoneShell}>
      <ChatListOpenContext value={setChatListOpen}>
        <div
          className={cx(
            "flex h-[var(--app-height,100svh)] flex-col bg-primary pt-safe-top pr-safe-right pl-safe-left font-body antialiased",
            !standalone && "lg:bg-sidebar",
            !tabBar && "pb-safe-bottom",
          )}
        >
          <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
            <div className={standalone ? "hidden" : "contents"}>
              <ShellLinks>
                <SidebarExpanded
                  activeUrl={activeUrl}
                  items={navItems}
                  header={
                    <>
                      <div className="flex min-w-0 flex-1">{workspaceSwitcher}</div>
                      <SidebarToggle />
                    </>
                  }
                  search={<SearchField />}
                  footer={
                    <>
                      <WhatsNewRow base={base} />
                      <UserRow
                        base={base}
                        user={user}
                        onSignOut={onSignOut}
                        workspaceSlug={currentWorkspace.slug}
                      />
                    </>
                  }
                />
                <SidebarRail
                  activeUrl={activeUrl}
                  items={navItems}
                  header={
                    <>
                      <SidebarToggle expand />
                      {phoneShell.workspaceSwitcher}
                      <SearchRailButton />
                    </>
                  }
                  footer={
                    <>
                      <WhatsNewRailButton base={base} />
                      <NotificationBell
                        workspaceSlug={currentWorkspace.slug}
                        badgeRing="ring-sidebar"
                      />
                      <UserMenuCard compact base={base} user={user} onSignOut={onSignOut} />
                    </>
                  }
                />
              </ShellLinks>
            </div>

            <div
              className={cx(
                "flex min-h-0 min-w-0 flex-1 flex-col",
                !standalone && "lg:p-2 lg:pl-0",
              )}
            >
              <div
                className={cx(
                  "flex min-h-0 min-w-0 flex-1 flex-col bg-primary",
                  !standalone &&
                    "lg:overflow-hidden lg:rounded-xl lg:has-[[data-panel-cards]]:overflow-visible lg:has-[[data-panel-cards]]:rounded-none lg:has-[[data-panel-cards]]:bg-transparent",
                )}
              >
                <ChatListShownContext value={phone && chatListOpen}>
                  {children}
                </ChatListShownContext>
              </div>
            </div>
          </div>
          {tabBar && chatHref && activityHref && (
            <ShellLinks>
              <PhoneTabBar
                current={tabBar}
                chatHref={chatHref}
                activityHref={activityHref}
                activityUnread={{
                  count: activityItem?.unreadCount,
                  lit: Boolean(activityItem?.badge),
                }}
                base={base}
                user={user}
              />
            </ShellLinks>
          )}
        </div>
      </ChatListOpenContext>
    </PhoneShellContext>
  );
}

function UserRow({
  workspaceSlug,
  ...menu
}: {
  base: string;
  user: AppUser;
  onSignOut: () => Promise<void> | void;
  workspaceSlug: string;
}) {
  return (
    <div className="group/user flex h-10 items-center rounded-lg transition-colors duration-100 ease-out hover:bg-sidebar-item-active has-[[aria-expanded=true]]:bg-sidebar-item-active has-[[aria-expanded=true]]:[--user-ring:var(--color-sidebar-item-active)]">
      <UserMenuCard {...menu} />
      <NotificationBell
        workspaceSlug={workspaceSlug}
        badgeRing="ring-[var(--user-ring,var(--color-sidebar))] group-hover/user:ring-sidebar-item-active"
      />
    </div>
  );
}

function UserMenuCard({
  base,
  user,
  onSignOut,
  compact = false,
}: {
  base: string;
  user: AppUser;
  onSignOut: () => Promise<void> | void;
  compact?: boolean;
}) {
  const avatar = (
    <ActorAvatar
      presence={false}
      size="xs"
      name={user.name}
      alt={user.name}
      src={user.avatarUrl}
      rounded={compact}
      className={compact ? undefined : "rounded-md"}
    />
  );
  const openShortcuts = useOpenKeyboardShortcuts();
  return (
    <Dropdown.Root>
      {compact ? (
        <AriaButton
          aria-label={`${m.controls_current_user()}: ${user.name}`}
          className="relative flex size-10 items-center justify-center rounded-full outline-focus-ring transition duration-100 ease-out focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          {avatar}
        </AriaButton>
      ) : (
        <AriaButton
          aria-label={m.controls_current_user()}
          className="flex h-full min-w-0 flex-1 items-center gap-2.5 rounded-lg pl-2.5 text-left outline-focus-ring focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          {avatar}
          <span className="min-w-0 truncate text-sm font-medium text-nav-fg transition-colors duration-100 ease-out group-hover/user:text-secondary">
            {user.name}
          </span>
        </AriaButton>
      )}
      <Dropdown.Popover placement={compact ? "right bottom" : "top left"} className="w-64">
        <div className="flex items-center gap-3 border-b border-secondary px-3.5 py-3">
          {avatar}
          <UserIdentity user={user} />
        </div>
        <Dropdown.Menu
          onAction={(key) => {
            if (key === "sign-out") void onSignOut();
            if (key === "shortcuts") openShortcuts();
          }}
        >
          <Dropdown.Item
            id="settings"
            label={m.navigation_personal_settings()}
            href={localizeHref(`${base}/settings`)}
            icon={Settings01}
          />
          <Dropdown.Item
            id="shortcuts"
            label={m.shortcuts_title()}
            addon={hotkeyLabel(HOTKEYS.shortcuts, isApplePlatform())}
            icon={Keyboard01}
          />
          <Dropdown.Separator />
          <Dropdown.Item id="sign-out" label={m.controls_sign_out()} icon={LogOut} />
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown.Root>
  );
}

function UserIdentity({ user }: { user: AppUser }) {
  return (
    <span className="grid min-w-0 flex-1">
      <span className="truncate text-sm font-semibold text-primary">{user.name}</span>
      {user.email ? <span className="truncate text-sm text-tertiary">{user.email}</span> : null}
    </span>
  );
}
