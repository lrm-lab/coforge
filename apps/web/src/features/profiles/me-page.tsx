import { Announcement02, LogOut01, Settings01 } from "@untitledui/icons";

import { usePhoneShell } from "#src/components/layout/phone-shell";
import { ShellLinks } from "#src/components/layout/shell-links";
import { TabPageHeader } from "#src/components/layout/tab-home-header";
import { TabPageRow } from "#src/components/layout/tab-page-row";
import { UnreadDot } from "#src/components/ui/unread-marker";
import { ActorAvatar } from "#src/features/avatars/actor-avatar";
import { useWhatsNewEntry } from "#src/features/whats-new/whats-new-entry";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { workspacePath } from "#src/features/workspaces/workspace-url";
import { m } from "#src/paraglide/messages";
import { localizeHref } from "#src/paraglide/runtime";

export function MePage() {
  const { user, onSignOut } = usePhoneShell();
  const workspaceSlug = useWorkspaceSlug();
  const whatsNew = useWhatsNewEntry(workspacePath(workspaceSlug));
  return (
    <ShellLinks>
      <div className="flex min-h-0 flex-1 flex-col">
        <TabPageHeader title={m.navigation_me()} />
        <div className="min-h-0 flex-1 overflow-y-auto lg:max-w-2xl">
          <div className="flex flex-col items-center gap-3 px-page py-8">
            <ActorAvatar
              presence={false}
              size="2xl"
              name={user.name}
              alt=""
              src={user.avatarUrl}
              rounded
            />
            <div className="grid min-w-0 max-w-full justify-items-center">
              <span className="max-w-full truncate text-lg font-semibold text-primary">
                {user.name}
              </span>
              {user.email ? (
                <span className="max-w-full truncate text-sm text-tertiary">{user.email}</span>
              ) : null}
            </div>
          </div>
          <ul className="divide-y divide-secondary border-y border-secondary">
            <TabPageRow
              icon={Settings01}
              label={m.navigation_personal_settings()}
              href={localizeHref(workspacePath(workspaceSlug, "/settings"))}
            />
            {whatsNew.visible && (
              <TabPageRow
                icon={Announcement02}
                label={m.whats_new_entry()}
                onPress={whatsNew.open}
                badge={<UnreadDot />}
              />
            )}
            <TabPageRow
              icon={LogOut01}
              label={m.controls_sign_out()}
              onPress={() => void onSignOut()}
              destructive
            />
          </ul>
        </div>
        {whatsNew.dialog}
      </div>
    </ShellLinks>
  );
}
