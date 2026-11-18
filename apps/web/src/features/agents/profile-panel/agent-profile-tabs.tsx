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
  const fade = useScrollEdges("x", { observe: '[role="tab"]', key: tabs.join(" ") });
  return (
    <div
      ref={fade.ref}
      style={edgeFadeStyle(fade)}
      className="scrollbar-hide -mx-5 flex h-full min-w-0 flex-1 items-end overflow-x-auto px-5"
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
  );
}
