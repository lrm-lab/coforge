import { useRef, type FC, type RefObject } from "react";
import { Keyboard01, LogOut01 as LogOut, Settings01 } from "@untitledui/icons";
import {
  Button as AriaButton,
  Header as AriaHeader,
  Menu as AriaMenu,
  MenuItem as AriaMenuItem,
  MenuSection as AriaMenuSection,
  MenuTrigger as AriaMenuTrigger,
  Popover as AriaPopover,
  Text as AriaText,
} from "react-aria-components";

import type { AppUser } from "#src/components/app-shell";
import { HotkeyKeycaps, useHotkeyAria } from "#src/components/ui/kbd";
import { ActorAvatar } from "#src/features/avatars/actor-avatar";
import { useOpenKeyboardShortcuts } from "#src/features/shortcuts/keyboard-shortcuts-host";
import { useShortcutBindings } from "#src/features/shortcuts/shortcut-bindings";
import { NotificationBell } from "#src/features/usage-limits/notification-bell";
import { m } from "#src/paraglide/messages";
import { localizeHref } from "#src/paraglide/runtime";
import { cx } from "#src/utils/cx";
import { POPOVER_MOTION } from "#src/utils/popover-motion";

export function UserRow({
  workspaceSlug,
  ...menu
}: {
  base: string;
  user: AppUser;
  onSignOut: () => Promise<void> | void;
  workspaceSlug: string;
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  return (
    <div
      ref={rowRef}
      className="group/user flex h-10 items-center rounded-lg transition-colors duration-100 ease-out hover:bg-sidebar-item-active has-[[aria-expanded=true]]:bg-sidebar-item-active has-[[aria-expanded=true]]:[--user-ring:var(--color-sidebar-item-active)]"
    >
      <UserMenuCard {...menu} anchorRef={rowRef} />
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
  anchorRef,
}: {
  base: string;
  user: AppUser;
  onSignOut: () => Promise<void> | void;
  compact?: boolean;
  anchorRef?: RefObject<HTMLElement | null>;
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
    <AriaMenuTrigger>
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
      <AriaPopover
        placement="end bottom"
        {...(anchorRef ? { triggerRef: anchorRef } : undefined)}
        offset={anchorRef ? 20 : 16}
        className={cx(
          "w-66 max-w-[calc(100vw-1rem)] origin-(--trigger-anchor-point) overflow-hidden rounded-xl bg-secondary_alt shadow-lg ring-1 ring-secondary_alt outline-hidden will-change-transform",
          POPOVER_MOTION,
        )}
      >
        <AriaMenu
          data-no-sliding-hl=""
          aria-label={m.controls_current_user()}
          onAction={(key) => {
            if (key === "sign-out") void onSignOut();
            if (key === "shortcuts") openShortcuts();
          }}
          className="outline-hidden"
        >
          <AriaMenuSection className="rounded-xl bg-primary_alt pb-1.5 ring-1 ring-secondary">
            <AriaHeader className="mb-1.5 flex items-center gap-3 border-b border-secondary px-3.5 py-3">
              <span aria-hidden="true" className="shrink-0">
                {avatar}
              </span>
              <UserIdentity user={user} />
            </AriaHeader>
            <AccountMenuItem
              id="settings"
              label={m.navigation_personal_settings()}
              href={localizeHref(`${base}/settings`)}
              icon={Settings01}
            />
            <AccountMenuItem
              id="shortcuts"
              label={m.shortcuts_title()}
              shortcut={shortcutsBinding}
              icon={Keyboard01}
            />
          </AriaMenuSection>
          <AriaMenuSection aria-label={m.controls_sign_out()} className="py-1.5">
            <AccountMenuItem id="sign-out" label={m.controls_sign_out()} icon={LogOut} tray />
          </AriaMenuSection>
        </AriaMenu>
      </AriaPopover>
    </AriaMenuTrigger>
  );
}

function AccountMenuItem({
  id,
  label,
  href,
  shortcut,
  icon: Icon,
  tray = false,
}: {
  id: string;
  label: string;
  href?: string;
  shortcut?: string;
  icon: FC<{ className?: string }>;
  tray?: boolean;
}) {
  const keyShortcuts = useHotkeyAria(shortcut);
  return (
    <AriaMenuItem
      id={id}
      href={href}
      textValue={label}
      aria-keyshortcuts={keyShortcuts}
      className="group/item block cursor-pointer px-1.5 py-px outline-hidden"
    >
      <div
        className={cx(
          "flex w-full items-center justify-between gap-3 rounded-md px-2.5 py-2 outline-focus-ring transition-colors duration-100 ease-out group-data-[focus-visible]/item:outline-2 group-data-[focus-visible]/item:-outline-offset-2",
          tray
            ? "group-data-[focused]/item:bg-tertiary group-data-[hovered]/item:bg-tertiary"
            : "group-data-[focused]/item:bg-active group-data-[hovered]/item:bg-active",
        )}
      >
        <span className="flex min-w-0 items-center gap-2 text-sm font-semibold text-secondary transition-colors duration-100 ease-out group-data-[focused]/item:text-secondary_hover group-data-[hovered]/item:text-secondary_hover">
          <Icon
            aria-hidden="true"
            className="size-4.5 shrink-0 text-fg-quaternary transition-colors duration-100 ease-out group-data-[focused]/item:text-fg-quaternary_hover group-data-[hovered]/item:text-fg-quaternary_hover"
          />
          <AriaText slot="label" className="truncate">
            {label}
          </AriaText>
        </span>
        {shortcut && <HotkeyKeycaps hotkey={shortcut} hideOnTouch ariaHidden />}
      </div>
    </AriaMenuItem>
  );
}

function UserIdentity({ user }: { user: AppUser }) {
  return (
    <span className="flex min-w-0 flex-1 flex-col">
      <span className="truncate text-sm font-semibold text-primary">{user.name}</span>
      {user.email ? <span className="truncate text-sm text-tertiary">{user.email}</span> : null}
    </span>
  );
}
