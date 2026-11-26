import { useState, type ReactNode } from "react";

import { OVERLAY_LAYER } from "#src/lib/overlay-layer";
import {
  Dialog as SlideoutDialog,
  Modal as SlideoutModal,
  ModalOverlay as SlideoutOverlay,
} from "#src/components/application/slideout-menus/slideout-menu";
import {
  LazyAgentProfilePanel,
  LazyPersonProfilePanel,
} from "#src/features/agents/profile-panel/lazy-profile-panels";
import type {
  OpenAgentProfile,
  OpenPersonProfile,
} from "#src/features/agents/profile-panel/open-agent-profile";
import type { AgentProfileTab } from "#src/features/agents/profile-panel/profile-panel-search";
import { m } from "#src/paraglide/messages";

type Profile = { kind: "agent" | "person"; id: string; tab?: AgentProfileTab };

export function useTaskPopupProfile(taskId: string | undefined): {
  openers: { onOpenAgentProfile: OpenAgentProfile; onOpenPersonProfile: OpenPersonProfile };
  layer: ReactNode;
} {
  const [opened, setOpened] = useState<Profile & { taskId: string }>();
  const profile = opened && opened.taskId === taskId ? opened : undefined;
  const close = () => setOpened(undefined);
  const open = (next: Profile) => {
    if (!taskId) return;
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
                  <LazyAgentProfilePanel
                    key={profile.id}
                    agentId={profile.id}
                    requestedTab={profile.tab}
                    onTabChange={(tab) => setOpened({ ...profile, tab })}
                    onClose={close}
                  />
                ) : (
                  <LazyPersonProfilePanel
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
