import { Keyboard01, LogOut01 as LogOut, Settings01 } from "@untitledui/icons";
import { Button as AriaButton } from "react-aria-components";

import type { AppUser } from "#src/components/app-shell";
import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { ActorAvatar } from "#src/features/avatars/actor-avatar";
import { useOpenKeyboardShortcuts } from "#src/features/shortcuts/keyboard-shortcuts-host";
import { useShortcutBindings } from "#src/features/shortcuts/shortcut-bindings";
import { NotificationBell } from "#src/features/usage-limits/notification-bell";
import { hotkeyLabel } from "#src/lib/hotkeys";
import { isApplePlatform } from "#src/lib/platform";
import { m } from "#src/paraglide/messages";
import { localizeHref } from "#src/paraglide/runtime";

export function UserRow({
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

export function UserMenuCard({
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
  const shortcutsBinding = useShortcutBindings("shortcuts")[0];
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
          className="flex h-full min-w-0 flex-1 items-center gap-2.5 rounded-lg ps-2.5 text-start outline-focus-ring focus-visible:outline-2 focus-visible:outline-offset-2"
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
            addon={shortcutsBinding ? hotkeyLabel(shortcutsBinding, isApplePlatform()) : undefined}
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
