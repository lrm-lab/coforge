import {
  Activity as ActivityIcon,
  AlarmClock,
  Folder,
  Grid01,
  MessageChatCircle,
  UserCircle as UserRound,
} from "@untitledui/icons";

import { ReorderableTabStrip } from "#src/components/ui/reorderable-tab-strip";
import { usePanelTabOrder } from "#src/features/panel-tabs/panel-tab-order-context";
import { edgeFadeStyle, useScrollEdges } from "#src/hooks/use-scroll-edges";
import { m } from "#src/paraglide/messages";
import { visibleAgentProfileTabs, type AgentProfileTab } from "./profile-panel-search";

const TABS = {
  profile: { label: m.agent_profile_tab, icon: UserRound },
  chat: { label: m.agent_chat_tab, icon: MessageChatCircle },
  reminders: { label: m.agent_reminders_tab, icon: AlarmClock },
  activity: { label: m.agent_activity_tab, icon: ActivityIcon },
  workspace: { label: m.agent_workspace_tab, icon: Folder },
  apps: { label: m.agent_apps_tab, icon: Grid01 },
};

/** The tabs this viewer may see, in their saved order; the first one is the panel's default. */
export function useAgentProfileTabOrder(
  canSeeManagerTabs: boolean,
  canSeeApps: boolean,
  canSeeChat: boolean,
) {
  return usePanelTabOrder(
    "agentProfile",
    visibleAgentProfileTabs(canSeeManagerTabs, canSeeApps, canSeeChat),
  );
}

/**
 * The panel's second band: the reorderable icon + label underline tab strip on the band's bottom
 * rule. The rule is the band's own hairline, drawn under the strip, so the active tab's underline
 * stands in for it. The strip scrolls sideways when its tabs do not fit instead of pushing the
 * panel wider, keeping the selected tab in view; the rule stays put. An edge with more tabs past
 * it fades out, so a tab cut off there reads as "scroll for more" rather than as a clipped label.
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
  // Each tab's width (a label grows once its font arrives) moves the edges too.
  const fade = useScrollEdges("x", { observe: '[role="tab"]', key: tabs.join(" ") });
  return (
    <div className="relative shrink-0 before:absolute before:inset-x-0 before:bottom-0 before:h-px before:bg-border-secondary">
      <div
        ref={fade.ref}
        style={edgeFadeStyle(fade)}
        className="scrollbar-hide flex items-end overflow-x-auto px-5 pt-1"
      >
        <ReorderableTabStrip
          aria-label={m.agent_profile_panel_tabs()}
          tabs={tabs}
          meta={TABS}
          active={active}
          onSelect={onSelect}
          onReorder={onReorder}
          size="sm"
          scrollRef={fade.ref}
        />
      </div>
    </div>
  );
}
