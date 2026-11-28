import {
  Activity as ActivityIcon,
  AlarmClock,
  BarChart01,
  Folder,
  Grid01,
  MessageChatCircle,
  UserCircle as UserRound,
} from "@untitledui/icons";

import { PANE_SUBBAR_ATTR } from "#src/components/layout/pane-header";
import { ReorderableTabStrip } from "#src/components/ui/reorderable-tab-strip";
import { usePanelTabOrder } from "#src/features/panel-tabs/panel-tab-order-context";
import { edgeFadeStyle, TAB_BAR_END_FADE_WIDTH, useScrollEdges } from "#src/hooks/use-scroll-edges";
import { m } from "#src/paraglide/messages";
import { visibleAgentProfileTabs, type AgentProfileTab } from "./profile-panel-search";

const TABS = {
  profile: { label: m.agent_profile_tab, icon: UserRound },
  chat: { label: m.agent_chat_tab, icon: MessageChatCircle },
  reminders: { label: m.agent_reminders_tab, icon: AlarmClock },
  activity: { label: m.agent_activity_tab, icon: ActivityIcon },
  workspace: { label: m.agent_workspace_tab, icon: Folder },
  apps: { label: m.agent_apps_tab, icon: Grid01 },
  usage: { label: m.agent_usage_tab, icon: BarChart01 },
};

export function useAgentProfileTabOrder(
  canSeeManagerTabs: boolean,
  canSeeApps: boolean,
  canSeeChat: boolean,
  canSeeUsage = canSeeManagerTabs,
) {
  return usePanelTabOrder(
    "agentProfile",
    visibleAgentProfileTabs(canSeeManagerTabs, canSeeApps, canSeeChat, canSeeUsage),
  );
}

export function useAgentProfileTabsForProfile(
  profile: { appBot?: unknown; hosting?: string; deletedAt?: unknown } | null | undefined,
  canManage: boolean,
) {
  const deleted = Boolean(profile?.deletedAt);
  const canSeeApps = Boolean(profile) && !deleted && !profile?.appBot;
  const canSeeChat = Boolean(profile) && !deleted && (canManage || Boolean(profile?.appBot));
  const canSeeUsage =
    Boolean(profile) && canManage && !profile?.appBot && profile?.hosting !== "external";
  return useAgentProfileTabOrder(canManage, canSeeApps, canSeeChat, canSeeUsage);
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
      {...PANE_SUBBAR_ATTR}
      className="relative shrink-0 before:absolute before:inset-x-0 before:bottom-0 before:h-px before:bg-border-secondary"
    >
      <div
        ref={fade.ref}
        style={edgeFadeStyle(fade, { end: TAB_BAR_END_FADE_WIDTH })}
        className="scrollbar-hide flex h-pane-subbar items-center overflow-x-auto overflow-y-hidden px-3 scroll-ps-3 scroll-pe-14"
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
