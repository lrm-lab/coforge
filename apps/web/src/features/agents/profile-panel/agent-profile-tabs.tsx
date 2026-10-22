import { useRef } from "react";
import {
  Activity as ActivityIcon,
  Bell01 as Bell,
  Folder,
  Grid01,
  UserCircle as UserRound,
} from "@untitledui/icons";

import { ReorderableTabStrip } from "#src/components/ui/reorderable-tab-strip";
import { usePanelTabOrder } from "#src/features/panel-tabs/panel-tab-order-context";
import { m } from "#src/paraglide/messages";
import { visibleAgentProfileTabs, type AgentProfileTab } from "./profile-panel-search";

const TABS = {
  profile: { label: m.agent_profile_tab, icon: UserRound },
  reminders: { label: m.agent_reminders_tab, icon: Bell },
  activity: { label: m.agent_activity_tab, icon: ActivityIcon },
  workspace: { label: m.agent_workspace_tab, icon: Folder },
  apps: { label: m.agent_apps_tab, icon: Grid01 },
};

/** The tabs this viewer may see, in their saved order; the first one is the panel's default. */
export function useAgentProfileTabOrder(
  canSeeManagerTabs: boolean,
  canSeeWorkspace: boolean,
  canSeeApps: boolean,
) {
  return usePanelTabOrder(
    "agentProfile",
    visibleAgentProfileTabs(canSeeManagerTabs, canSeeWorkspace, canSeeApps),
  );
}

/**
 * The panel's second band: the reorderable icon + label underline tab strip on the band's bottom
 * rule. The rule is the band's own hairline, drawn under the strip, so the active tab's underline
 * stands in for it. The strip scrolls sideways when its tabs do not fit instead of pushing the
 * panel wider, keeping the selected tab in view; the rule stays put.
 */
export function AgentProfileTabs({
  active,
  tabs,
  onSelect,
  onReorder,
}: {
  active: AgentProfileTab;
  tabs: AgentProfileTab[];
  onSelect: (tab: AgentProfileTab) => void;
  onReorder: (order: AgentProfileTab[]) => void;
}) {
  const strip = useRef<HTMLDivElement>(null);
  return (
    <div className="relative shrink-0 before:absolute before:inset-x-0 before:bottom-0 before:h-px before:bg-border-secondary">
      <div ref={strip} className="scrollbar-hide flex items-end overflow-x-auto px-5 pt-1">
        <ReorderableTabStrip
          aria-label={m.agent_profile_panel_tabs()}
          tabs={tabs}
          meta={TABS}
          active={active}
          onSelect={onSelect}
          onReorder={onReorder}
          size="sm"
          scrollRef={strip}
        />
      </div>
    </div>
  );
}
