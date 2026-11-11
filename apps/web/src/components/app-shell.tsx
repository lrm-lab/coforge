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
import { PhoneShellContext, type PhoneShell } from "#src/components/layout/phone-shell";
import { PhoneTabBar } from "#src/components/layout/phone-tab-bar";
import { ShellLinks } from "#src/components/layout/shell-links";
import { tabHomeOf } from "#src/components/layout/tab-home";
import { UnreadBadge, UnreadDot } from "#src/components/ui/unread-marker";
import { rememberRecordsLastPath, recordsNavHref } from "#src/features/records/records-last-path";
import {
  activityNavAttentionQuery,
  activityNavAttentionRealtime,
} from "#src/features/inbox/activity-inbox-queries";
import { useActivityInboxRealtime } from "#src/features/inbox/use-activity-inbox-realtime";
import { NotificationBell } from "#src/features/usage-limits/notification-bell";
import { SystemNotificationsProvider } from "#src/features/usage-limits/system-notifications-provider";
import { WhatsNewRailButton, WhatsNewRow } from "#src/features/whats-new/whats-new-entry";
import {
  WorkspaceSwitcher,
  type WorkspaceOption,
} from "#src/features/workspaces/workspace-switcher";
import type { CreateWorkspaceInput } from "#src/features/workspaces/create-workspace-form";
import { useReportActivityUnread, useWorkspaceTabTitle } from "#src/lib/browser-tab";
import { m } from "#src/paraglide/messages";
import { localizeHref } from "#src/paraglide/runtime";
import { TopBarBusyAgents } from "#src/features/agents/shell-busy-agents";
import { SearchField } from "#src/features/search/search-field";
import { AppTopBar } from "#src/components/layout/app-top-bar";
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

/** Chat is the Workspace's home page ("") and its conversations. */
const CHAT_SECTIONS = ["", "channel", "messages", "saved", "drafts"];

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
  /** A heading that starts a new group at this item. */
  groupLabel?: string;
  /** The phone's tab bar carries this item itself; the Workspace tab lists the rest. */
  tab?: "chat" | "activity";
})[] {
  const recordsDot = recordsPreview ? <UnreadDot className="ml-auto" /> : undefined;
  // The number when the server counts some, else the dot while anything is unread (an item the
  // count leaves out, such as a Task, or a server that counts nothing).
  const unreadCount =
    activity.unreadCount && activity.unreadCount > 0 ? activity.unreadCount : undefined;
  const activityBadge =
    unreadCount !== undefined ? (
      <>
        <UnreadBadge count={unreadCount} />
        {/* The badge is hidden from assistive tech, so the row names its count here. */}
        <span className="sr-only">{m.conversation_thread_unread({ count: unreadCount })}</span>
      </>
    ) : activity.hasUnread ? (
      <UnreadDot className="ml-auto" />
    ) : undefined;
  const recordsHref = recordsNavHref(workspaceId);
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
    // What the Workspace shares sits under its own heading, apart from the viewer's own
    // conversations and activity.
    {
      label: m.projects_title(),
      ...item("projects"),
      icon: Folder,
      groupLabel: m.navigation_workspace_group(),
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
  const search = useRouterState({ select: (state) => state.location.search });
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
  const section = pathname.slice(base.length).split("/")[1] ?? "";
  // The phone's tab bar shows on a tab home only; Chat's list is on screen without its own address
  // when a conversation's back arrow brings it back, which the page reports.
  const [chatListOpen, setChatListOpen] = useState(false);
  const tabHome = tabHomeOf({ section, search, chatListOpen });
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
  const phoneShell: PhoneShell = {
    workspaceSwitcher: (
      <WorkspaceSwitcher
        workspaces={workspaces}
        current={currentWorkspace}
        onSelect={onSelectWorkspace}
        onCreate={onCreateWorkspace}
        trigger="mark"
      />
    ),
    workspaceItems: navItems.filter(
      (item): item is typeof item & { href: string } => !item.tab && item.href !== undefined,
    ),
    user,
    onSignOut,
    setChatListOpen,
  };

  return (
    <SystemNotificationsProvider viewerId={user.id} enabled={canSeeUsageLimits}>
      <PhoneShellContext value={phoneShell}>
        {/* Clears the notch on a phone, and its home indicator unless the tab bar, which has its own
        padding for it, is showing. */}
        <div
          className={cx(
            "flex h-svh flex-col bg-primary safe-area-padding font-body antialiased lg:bg-sidebar",
            tabHome && "max-lg:pb-0!",
          )}
        >
          <ShellLinks>
            <AppTopBar
              workspace={workspaceSwitcher}
              agents={<TopBarBusyAgents />}
              search={<SearchField />}
              end={
                <>
                  <NotificationBell workspaceSlug={currentWorkspace.slug} />
                  <UserMenuCard compact base={base} user={user} onSignOut={onSignOut} />
                </>
              }
            />
          </ShellLinks>
          <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
            {/* `contents` keeps the sidebars direct flex items of this row. On desktop
            `sidebar-collapsed` on <html> picks the expanded one or the rail; a phone has neither, its
            tab bar below the content takes their place. */}
            <ShellLinks>
              <SidebarExpanded activeUrl={activeUrl} items={navItems} footer={<WhatsNewRow />} />
              <SidebarRail activeUrl={activeUrl} items={navItems} footer={<WhatsNewRailButton />} />
            </ShellLinks>

            {/* On desktop the content is one white card under the top bar, inset 8px from the sidebar's
            background; a page made of several panels (Chat) divides the card with hairlines, never
            separate cards, so what belongs together reads as one block. */}
            <div className="flex min-h-0 min-w-0 flex-1 flex-col lg:p-2 lg:pt-0 lg:pl-0">
              <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-primary lg:overflow-hidden lg:rounded-xl">
                {children}
              </div>
            </div>
          </div>
          {tabHome && chatItem?.href && activityItem?.href && (
            <ShellLinks>
              <PhoneTabBar
                current={tabHome}
                chatHref={chatItem.href}
                activityHref={activityItem.href}
                activityUnread={{
                  count: activityItem.unreadCount,
                  lit: Boolean(activityItem.badge),
                }}
                base={base}
                user={user}
              />
            </ShellLinks>
          )}
        </div>
      </PhoneShellContext>
    </SystemNotificationsProvider>
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
  /** The avatar alone, in the desktop top bar; the menu drops below it. */
  compact?: boolean;
}) {
  const avatar = (
    <ActorAvatar
      presence={false}
      size="xs"
      name={user.name}
      alt={user.name}
      src={user.avatarUrl}
      // An uploaded photo is a rounded square in the full card, a circle in the top bar; a sticker
      // is bare either way.
      rounded={compact}
      className={compact ? undefined : "rounded-md"}
    />
  );
  return (
    <Dropdown.Root>
      {compact ? (
        <AriaButton
          aria-label={`${m.controls_current_user()}: ${user.name}`}
          className="relative flex size-8 items-center justify-center rounded-full outline-focus-ring transition duration-100 ease-linear focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          {avatar}
        </AriaButton>
      ) : (
        <AriaButton
          aria-label={m.controls_current_user()}
          className="relative flex h-10 w-full items-center gap-2.5 rounded-lg px-2.5 text-left outline-focus-ring transition duration-100 ease-linear hover:bg-sidebar-accent focus-visible:outline-2 focus-visible:outline-offset-2 aria-expanded:bg-sidebar-accent"
        >
          {avatar}
          <UserIdentity user={user} />
        </AriaButton>
      )}
      <Dropdown.Popover
        placement={compact ? "bottom end" : "top left"}
        className={compact ? "w-64" : "w-(--trigger-width) min-w-56"}
      >
        <div className="flex items-center gap-3 border-b border-secondary px-3.5 py-3">
          {compact ? null : avatar}
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
