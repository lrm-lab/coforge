import { useState, type ReactNode } from "react";

import { OVERLAY_LAYER } from "#src/lib/overlay-layer";
import {
  Dialog as SlideoutDialog,
  Modal as SlideoutModal,
  ModalOverlay as SlideoutOverlay,
} from "#src/components/application/slideout-menus/slideout-menu";
import { AgentProfilePanel } from "#src/features/agents/profile-panel/agent-profile-panel";
import { PersonProfilePanel } from "#src/features/agents/person-profile-panel";
import type {
  OpenAgentProfile,
  OpenPersonProfile,
} from "#src/features/agents/profile-panel/open-agent-profile";
import type { AgentProfileTab } from "#src/features/agents/profile-panel/profile-panel-search";
import { m } from "#src/paraglide/messages";

type Profile = { kind: "agent" | "person"; id: string; tab?: AgentProfileTab };

/**
 * A profile opened from inside a Task popup (a sender's avatar or name in its discussion) opens
 * over the popup, as the next overlay, not in the conversation's side slot under it (Frank, 11-04,
 * task #519). It is the popup's own: Escape or a press outside closes it first and the popup
 * second, the order every React Aria overlay already keeps, and it goes with the Task it was
 * opened from. Like the channel settings panel's, it lives outside the address.
 */
export function useTaskPopupProfile(taskId: string | undefined): {
  /** The panes' profile openers, in place of the conversation's. */
  openers: { onOpenAgentProfile: OpenAgentProfile; onOpenPersonProfile: OpenPersonProfile };
  layer: ReactNode;
} {
  const [opened, setOpened] = useState<Profile & { taskId: string }>();
  const profile = opened && opened.taskId === taskId ? opened : undefined;
  const close = () => setOpened(undefined);
  const open = (next: Profile) => {
    if (!taskId) return;
    // Closing the profile gives focus back to what had it when it opened. Not the avatar: React
    // Aria's PreviewTrigger marks every Escape on its trigger handled, open peek or not, and the
    // popup leaves a handled Escape alone, so the next Escape would not close it. The popup's own
    // dialog has it instead.
    if (document.activeElement instanceof HTMLElement)
      document.activeElement.closest<HTMLElement>('[role="dialog"]')?.focus();
    setOpened({ ...next, taskId });
  };
  return {
    openers: {
      onOpenAgentProfile: (id, tab) => open({ kind: "agent", id, tab }),
      onOpenPersonProfile: (id) => open({ kind: "person", id }),
    },
    layer: (
      <SlideoutOverlay
        className={OVERLAY_LAYER}
        isOpen={Boolean(profile)}
        isDismissable
        onOpenChange={(next) => next || close()}
      >
        <SlideoutModal className="max-w-136">
          <SlideoutDialog aria-label={m.agent_profile_tab()} className="gap-0">
            {profile && (
              <div className="flex min-h-0 w-full flex-1 flex-col">
                {profile.kind === "agent" ? (
                  <AgentProfilePanel
                    key={profile.id}
                    agentId={profile.id}
                    requestedTab={profile.tab}
                    onTabChange={(tab) => setOpened({ ...profile, tab })}
                    onClose={close}
                  />
                ) : (
                  <PersonProfilePanel
                    key={profile.id}
                    userId={profile.id}
                    onClose={close}
                    onOpenAgent={(id) => open({ kind: "agent", id })}
                  />
                )}
              </div>
            )}
          </SlideoutDialog>
        </SlideoutModal>
      </SlideoutOverlay>
    ),
  };
}
