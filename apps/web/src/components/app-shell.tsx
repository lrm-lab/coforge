import { useCallback, useEffect, type FC, type ReactNode } from "react";
import { useRouter, useRouterState } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  CheckSquare as ListTodo,
  File02 as FileText,
  Folder,
  LogOut01 as LogOut,
  MessageChatSquare,
  Monitor01 as Monitor,
  SearchLg,
  Settings01,
  Users01 as Users,
} from "@untitledui/icons";
import { Button as AriaButton } from "react-aria-components";

import type { NavItemType } from "#src/components/application/app-navigation/config";
import { Avatar } from "#src/components/base/avatar/avatar";
import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { SidebarRail } from "#src/components/layout/sidebar/sidebar-rail";
import { MobileDrawerProvider } from "#src/components/layout/sidebar/mobile-header";
import {
  SidebarExpanded,
  SidebarMobileDrawer,
} from "#src/components/layout/sidebar/sidebar-expanded";
import { UnreadDot } from "#src/components/ui/unread-marker";
import { rememberRecordsLastPath, recordsNavHref } from "#src/features/records/records-last-path";
import {
  ACTIVITY_INBOX_QUERY_PREFIX,
  activityNavAttentionQuery,
} from "#src/features/inbox/activity-inbox-queries";
import { useActivityInboxRealtime } from "#src/features/inbox/use-activity-inbox-realtime";
import {
  WorkspaceSwitcher,
  type WorkspaceOption,
} from "#src/features/workspaces/workspace-switcher";
import type { CreateWorkspaceInput } from "#src/features/workspaces/create-workspace-form";
import { avatarInitial, avatarToneClassName } from "#src/lib/avatar-tone";
import { m } from "#src/paraglide/messages";
import { localizeHref } from "#src/paraglide/runtime";
import { workspacePath } from "#src/features/workspaces/workspace-url";

export type AppUser = {
  id: string;
  name: string;
  /** Null for an account made with a phone number alone. */
  email: string | null;
  avatarUrl?: string | null;
};

/** Whether the viewer has unread activity anywhere — the nav Activity dot. Shares the inbox's
 * query prefix (an Activity page refresh also re-reads it) and re-reads on the same realtime
 * message signals the Activity page listens to, so a new message moves it without navigation. */
function useActivityAttention(user: AppUser, workspaceId?: string) {
  const queryClient = useQueryClient();
  const refresh = useCallback(
    () =>
      queryClient.invalidateQueries({
        queryKey: [...ACTIVITY_INBOX_QUERY_PREFIX, "nav-attention"],
      }),
    [queryClient],
  );
  useActivityInboxRealtime({
    workspaceId: workspaceId ?? "",
    userId: user.id,
    onActivity: refresh,
  });
  const query = useQuery(activityNavAttentionQuery());
  return (query.data?.unread ?? 0) > 0;
}

/** Chat is the Workspace's home page ("") and its conversations. */
const CHAT_SECTIONS = ["", "channel", "messages", "saved"];

function useNavItems(
  base: string,
  recordsPreview: boolean,
  workspaceId: string,
  activityDot?: ReactNode,
): (NavItemType & {
  icon: FC<{ className?: string }>;
  bareHref: string;
  /** Sections under `base` this item is also current for. */
  sections?: readonly string[];
})[] {
  const recordsDot = recordsPreview ? <UnreadDot className="ml-auto" /> : undefined;
  const recordsHref = recordsNavHref(workspaceId);
  const item = (section: string) => ({
    bareHref: `${base}/${section}`,
    href: localizeHref(`${base}/${section}`),
  });
  return [
    { label: m.search_title(), ...item("search"), icon: SearchLg },
    {
      label: m.navigation_chat(),
      bareHref: base,
      href: localizeHref(base),
      sections: CHAT_SECTIONS,
      icon: MessageChatSquare,
    },
    { label: m.navigation_activity(), ...item("activity"), icon: Activity, badge: activityDot },
    { label: m.tasks_tab(), ...item("tasks"), icon: ListTodo },
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
}

/** Official nav components render plain `<a href>` with no onClick hook, so
 * this routes same-origin, unmodified clicks through the router instead. */
function useSpaNavigation() {
  const router = useRouter();
  return useCallback(
    (event: React.MouseEvent<HTMLElement>) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return;
      }
      const anchor = (event.target as HTMLElement).closest("a[href]");
      if (!(anchor instanceof HTMLAnchorElement)) return;
      if (anchor.target && anchor.target !== "_self") return;
      const url = new URL(anchor.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      event.preventDefault();
      void router.navigate({ href: url.pathname + url.search + url.hash });
    },
    [router],
  );
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
}: {
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
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const searchStr = useRouterState({ select: (state) => state.location.searchStr });
  const workspaceId = currentWorkspace.id;
  const base = workspacePath(currentWorkspace.slug);
  useEffect(() => {
    if (!pathname.startsWith(`${base}/records`)) return;
    const search = !searchStr ? "" : searchStr.startsWith("?") ? searchStr : `?${searchStr}`;
    // Remembered within the Workspace, so it holds the path under `/w/<slug>`.
    rememberRecordsLastPath(workspaceId, `${pathname.slice(base.length)}${search}`);
  }, [workspaceId, base, pathname, searchStr]);
  const hasActivityAttention = useActivityAttention(user, workspaceId);
  const navItems = useNavItems(
    base,
    recordsPreview,
    workspaceId,
    hasActivityAttention ? <UnreadDot className="ml-auto" /> : undefined,
  );
  const section = pathname.slice(base.length).split("/")[1] ?? "";
  const activeUrl = navItems.find((item) =>
    item.sections
      ? item.sections.includes(section)
      : pathname === item.bareHref || pathname.startsWith(`${item.bareHref}/`),
  )?.href;
  const onSidebarClickCapture = useSpaNavigation();
  const workspaceSwitcher = (
    <WorkspaceSwitcher
      workspaces={workspaces}
      current={currentWorkspace}
      onSelect={onSelectWorkspace}
      onCreate={onCreateWorkspace}
    />
  );

  return (
    <MobileDrawerProvider>
      <div className="flex h-svh flex-col bg-primary font-body antialiased lg:flex-row lg:bg-(image:--sidebar-gradient)">
        {/* Each sidebar is `fixed` + a spacer div reserving its width in flow;
          `contents` keeps that pair as direct flex items of this `lg:flex` shell. The drawer is
          mobile only; on desktop `sidebar-collapsed` on <html> picks the expanded one or the rail. */}
        <div onClickCapture={onSidebarClickCapture} className="contents">
          <SidebarMobileDrawer
            activeUrl={activeUrl}
            items={navItems}
            subheader={workspaceSwitcher}
            footer={<UserMenuCard base={base} user={user} onSignOut={onSignOut} />}
          />
          <SidebarExpanded
            activeUrl={activeUrl}
            items={navItems}
            subheader={workspaceSwitcher}
            footer={<UserMenuCard base={base} user={user} onSignOut={onSignOut} />}
          />
          <SidebarRail
            activeUrl={activeUrl}
            items={navItems}
            subheader={
              <WorkspaceSwitcher
                compact
                workspaces={workspaces}
                current={currentWorkspace}
                onSelect={onSelectWorkspace}
                onCreate={onCreateWorkspace}
              />
            }
            footer={<UserMenuCard compact base={base} user={user} onSignOut={onSignOut} />}
          />
        </div>

        {/* On desktop the content is one white card inset 8px from the sidebar's background; a page
            made of several panels (Chat) marks itself `data-panel-cards` and draws a card per panel. */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col lg:p-2 lg:pl-0">
          <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-primary lg:overflow-hidden lg:rounded-xl lg:has-[[data-panel-cards]]:overflow-visible lg:has-[[data-panel-cards]]:rounded-none lg:has-[[data-panel-cards]]:bg-transparent">
            {children}
          </div>
        </div>
      </div>
    </MobileDrawerProvider>
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
  compact?: boolean;
}) {
  const avatar = (
    <Avatar
      size={compact ? "sm" : "md"}
      src={user.avatarUrl}
      alt={user.name}
      initials={avatarInitial(user.name)}
      contentClassName={avatarToneClassName(user.name)}
      rounded={compact}
      className={compact ? undefined : "rounded-lg"}
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
          className="relative flex w-full items-center gap-3 rounded-xl p-2 text-left outline-focus-ring transition duration-100 ease-linear hover:bg-sidebar-accent focus-visible:outline-2 focus-visible:outline-offset-2 aria-expanded:bg-sidebar-accent"
        >
          {avatar}
          <UserIdentity user={user} />
        </AriaButton>
      )}
      <Dropdown.Popover
        placement={compact ? "right bottom" : "top left"}
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
