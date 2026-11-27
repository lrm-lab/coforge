import {
  Announcement02,
  ChevronRight,
  LogOut01,
  MessageTextSquare01,
  Settings01,
} from "@untitledui/icons";
import { Button as AriaButton } from "react-aria-components";

import { usePhoneShell } from "#src/components/layout/phone-shell";
import { ShellLinks } from "#src/components/layout/shell-links";
import { TabPageHeader } from "#src/components/layout/tab-home-header";
import { TabPageRow } from "#src/components/layout/tab-page-row";
import { ListIconTile } from "#src/components/ui/list-icon-tile";
import { UnreadDot } from "#src/components/ui/unread-marker";
import { ActorAvatar } from "#src/features/avatars/actor-avatar";
import { useOpenFeedback } from "#src/features/feedback/feedback-host";
import { useWhatsNewEntry } from "#src/features/whats-new/whats-new-entry";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { workspacePath } from "#src/features/workspaces/workspace-url";
import { m } from "#src/paraglide/messages";
import { localizeHref } from "#src/paraglide/runtime";

export function MePage() {
  const { user, onSignOut } = usePhoneShell();
  const workspaceSlug = useWorkspaceSlug();
  const openFeedback = useOpenFeedback();
  const whatsNew = useWhatsNewEntry(workspacePath(workspaceSlug));
  return (
    <ShellLinks>
      <div className="flex min-h-0 flex-1 flex-col">
        <TabPageHeader title={m.navigation_me()} />
        <div data-tab-home-scroll="" className="min-h-0 flex-1 overflow-y-auto lg:max-w-2xl">
          <div className="flex flex-col items-center gap-3 px-page pt-7 pb-5">
            <ActorAvatar
              presence={false}
              size="2xl"
              name={user.name}
              alt=""
              src={user.avatarUrl}
              rounded
            />
            <div className="grid min-w-0 max-w-full justify-items-center gap-0.5 text-center">
              <span className="max-w-full text-lg font-semibold wrap-anywhere text-primary">
                {user.name}
              </span>
              {user.email ? (
                <span className="max-w-full text-sm wrap-anywhere text-tertiary">{user.email}</span>
              ) : null}
            </div>
          </div>
          <div className="px-page pb-5">
            <AriaButton
              aria-haspopup="dialog"
              onPress={openFeedback}
              className="group flex min-h-14 w-full items-center gap-3 rounded-xl border border-secondary bg-secondary px-3.5 py-3 text-start shadow-xs outline-focus-ring transition-colors duration-100 ease-out hover:bg-primary_hover focus-visible:outline-2 focus-visible:outline-offset-2"
            >
              <ListIconTile icon={MessageTextSquare01} className="bg-primary" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold text-primary">
                  {m.feedback_entry()}
                </span>
                <span className="mt-0.5 block text-xs leading-snug text-tertiary">
                  {m.feedback_entry_subtitle()}
                </span>
              </span>
              <ChevronRight
                aria-hidden="true"
                className="size-5 shrink-0 text-fg-quaternary transition-transform duration-100 ease-out motion-safe:group-hover:translate-x-0.5 rtl:rotate-180"
              />
            </AriaButton>
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
