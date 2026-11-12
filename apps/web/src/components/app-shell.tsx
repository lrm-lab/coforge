import { useEffect, useMemo, useState, type FC } from "react";
import { useRouterState } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  File02 as FileText,
  Folder,
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
  PhoneShellContext,
  type PhoneShell,
} from "#src/components/layout/phone-shell";
import { PhoneTabBar } from "#src/components/layout/phone-tab-bar";
import { ShellLinks } from "#src/components/layout/shell-links";
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
import { useBreakpoint } from "#src/hooks/use-breakpoint";
import { useLatestCallback } from "#src/hooks/use-latest-callback";
import { SearchField, SearchRailButton } from "#src/features/search/search-field";
import { SidebarToggle } from "#src/components/layout/sidebar/sidebar-toggle";
import { workspacePath } from "#src/features/workspaces/workspace-url";
import { ActorAvatar } from "#src/features/avatars/actor-avatar";
import { cx } from "#src/utils/cx";

export type AppUser = {
  id: string;
  name: string;
  /** Null for an account made with a phone number alone. */
  email: string | null;
  avatarUrl?: string | null;
};

/**
 * Whether the viewer has unread activity anywhere, and how many items when the server counts them
 * — the nav Activity badge. A message the server sent to this person's own channel lights it with
 * no read at all; a Done, read-all or mark-unread in any of their pages says where the inbox now
 * stands, which the badge takes; anything else that reaches the inbox (a mention from outside the
 * channel, a Task assignment) re-reads it (`activityNavAttentionRealtime`).
 */
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
  /** The Activity row's number, for the collapsed rail to draw on its icon. */
  unreadCount?: number;
  bareHref: string;
  /** Sections under `base` this item is also current for. */
  sections?: readonly string[];
  /** The phone's tab bar carries this item itself; the Workspace tab lists the rest. */
  tab?: "chat" | "activity";
})[] {
  // The number when the server counts some, else the dot while anything is unread (an item the
  // count leaves out, such as a Task, or a server that counts nothing).
  const unreadCount =
    activity.unreadCount && activity.unreadCount > 0 ? activity.unreadCount : undefined;
  const { hasUnread } = activity;
  // The Records link goes back to the page last open there, which changes as the person moves.
  const recordsHref = recordsNavHref(workspaceId);
  return useMemo(() => {
    const recordsDot = recordsPreview ? <UnreadDot className="ml-auto" /> : undefined;
    const activityBadge =
      unreadCount !== undefined ? (
        <>
          <UnreadBadge count={unreadCount} />
          {/* The badge is hidden from assistive tech, so the row names its count here. */}
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
      { label: m.projects_title(), ...item("projects"), icon: Folder },
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

export function AppShell({
  user,
  workspaces,
  currentWorkspace,
  onSelectWorkspace,
  onCreateWorkspace,
  onSignOut,
  children,
  recordsPreview = false,
  canSeeUsageLimits = false,
  aiWorkbench = false,
}: {
  /** Whether the Workspace has AI Workbench on; its sidebar entry shows only then. */
  aiWorkbench?: boolean;
  /** An owner or admin, who sees the Workspace's system notifications. */
  canSeeUsageLimits?: boolean;
  user: AppUser;
  workspaces: WorkspaceOption[];
  /** The Workspace the page URL names. */
  currentWorkspace: WorkspaceOption;
  onSelectWorkspace?: (slug: string) => Promise<void> | void;
  onCreateWorkspace?: (input: CreateWorkspaceInput) => Promise<void>;
  onSignOut: () => Promise<void> | void;
  /** Purple dot on 记录 for a Leader preview hour or an unread member assignment. */
  recordsPreview?: boolean;
  children: React.ReactNode;
}) {
  // pathname is de-localized (src/router.tsx); item.href is localized, so we
  // match on bareHref (with sub-route prefix matching) instead.
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const searchStr = useRouterState({
    select: (state) => state.location.searchStr,
  });
  const itemOpen = useRouterState({
    // The page's validated search, not the raw address: Activity drops an `open` it can't read,
    // and then shows its list, which the tab bar belongs under.
    select: (state) =>
      (state.matches.at(-1)?.search as { open?: unknown } | undefined)?.open !== undefined,
  });
  const workspaceId = currentWorkspace.id;
  const base = workspacePath(currentWorkspace.slug);
  useEffect(() => {
    if (!pathname.startsWith(`${base}/records`)) return;
    const query = !searchStr ? "" : searchStr.startsWith("?") ? searchStr : `?${searchStr}`;
    // Remembered within the Workspace, so it holds the path under `/w/<slug>`.
    rememberRecordsLastPath(workspaceId, `${pathname.slice(base.length)}${query}`);
  }, [workspaceId, base, pathname, searchStr]);
  const activityAttention = useActivityAttention(user, workspaceId);
  useReportActivityUnread(activityAttention.hasUnread, activityAttention.unreadCount);
  useWorkspaceTabTitle(currentWorkspace.name);
  const navItems = useNavItems(base, recordsPreview, workspaceId, aiWorkbench, activityAttention);
  const section = sectionOf(pathname);
  // The phone's tab bar shows on a tab home only; Chat's list is on screen without its own address
  // when a conversation's back arrow brings it back, which the page reports.
  const [chatListOpen, setChatListOpen] = useState(false);
  const tabHome = tabHomeOf({ section, itemOpen, chatListOpen });
  // The tab bar is mounted on a phone's tab home only, never hidden by CSS on a desktop.
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
  const tabBar = phone && chatHref && activityHref ? tabHome : null;
  // The Workspace layout hands its handlers and user over inline, so the tab pages' context keeps
  // them stable itself: it changes only with what the pages show.
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
    <SystemNotificationsProvider viewerId={user.id} enabled={canSeeUsageLimits}>
      <PhoneShellContext value={phoneShell}>
        <ChatListOpenContext value={setChatListOpen}>
          {/* Clears the notch on a phone, and its home indicator unless the tab bar, which has its own
        padding for it, is showing. */}
          <div
            className={cx(
              "flex h-svh flex-col bg-primary pt-safe-top pr-safe-right pl-safe-left font-body antialiased lg:bg-sidebar",
              !tabBar && "pb-safe-bottom",
            )}
          >
            <WhatsNewAnnouncer />
            <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
              {/* `contents` keeps the sidebars direct flex items of this row. On desktop
            `sidebar-collapsed` on <html> picks the expanded one or the rail; a phone has neither, its
            tab bar below the content takes their place. */}
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
                      <WhatsNewRow />
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
                      <WhatsNewRailButton />
                      <NotificationBell
                        workspaceSlug={currentWorkspace.slug}
                        badgeRing="ring-sidebar"
                      />
                      <UserMenuCard compact base={base} user={user} onSignOut={onSignOut} />
                    </>
                  }
                />
              </ShellLinks>

              {/* On desktop the content is one white card inset 8px from the sidebar's background; a
            page made of several panels (Chat, Settings, Records) marks itself `data-panel-cards` and
            draws a card per panel, 8px apart. */}
              <div className="flex min-h-0 min-w-0 flex-1 flex-col lg:p-2 lg:pl-0">
                <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-primary lg:overflow-hidden lg:rounded-xl lg:has-[[data-panel-cards]]:overflow-visible lg:has-[[data-panel-cards]]:rounded-none lg:has-[[data-panel-cards]]:bg-transparent">
                  {children}
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
    </SystemNotificationsProvider>
  );
}

/** The foot of the expanded sidebar: the user and the bell as one row on the nav rows' grid, the
 * avatar on the icons' column and the name on the labels' line, one hover surface for the whole
 * row. The email is in the menu, not under the name. */
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
    <div className="group/user flex h-10 items-center rounded-lg transition-colors duration-100 ease-linear hover:bg-sidebar-item-active has-[[aria-expanded=true]]:bg-sidebar-item-active">
      <UserMenuCard {...menu} />
      <NotificationBell
        workspaceSlug={workspaceSlug}
        badgeRing="ring-sidebar group-hover/user:ring-sidebar-item-active group-has-[[aria-expanded=true]]/user:ring-sidebar-item-active"
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
  /** The Workspace path (`/w/<slug>`) Settings lives under. */
  base: string;
  user: AppUser;
  onSignOut: () => Promise<void> | void;
  /** The avatar alone, at the foot of the collapsed rail. */
  compact?: boolean;
}) {
  const avatar = (
    <ActorAvatar
      presence={false}
      size="xs"
      name={user.name}
      alt={user.name}
      src={user.avatarUrl}
      // An uploaded photo is a rounded square in the row, a circle on the rail; a sticker is bare
      // either way.
      rounded={compact}
      className={compact ? undefined : "rounded-md"}
    />
  );
  return (
    <Dropdown.Root>
      {compact ? (
        <AriaButton
          aria-label={`${m.controls_current_user()}: ${user.name}`}
          className="relative flex size-10 items-center justify-center rounded-full outline-focus-ring transition duration-100 ease-linear focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          {avatar}
        </AriaButton>
      ) : (
        <AriaButton
          aria-label={m.controls_current_user()}
          className="flex h-full min-w-0 flex-1 items-center gap-2.5 rounded-lg pl-2.5 text-left outline-focus-ring focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          {avatar}
          <span className="min-w-0 truncate text-sm font-medium text-nav-fg transition-colors duration-100 ease-linear group-hover/user:text-secondary">
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
          }}
        >
          <Dropdown.Item
            id="settings"
            label={m.navigation_personal_settings()}
            href={localizeHref(`${base}/settings`)}
            icon={Settings01}
          />
          <Dropdown.Separator />
          <Dropdown.Item id="sign-out" label={m.controls_sign_out()} icon={LogOut} />
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown.Root>
  );
}

/** Name over email; the email is absent for an account made with a phone number alone. */
function UserIdentity({ user }: { user: AppUser }) {
  return (
    <span className="grid min-w-0 flex-1">
      <span className="truncate text-sm font-semibold text-primary">{user.name}</span>
      {user.email ? <span className="truncate text-sm text-tertiary">{user.email}</span> : null}
    </span>
  );
}
