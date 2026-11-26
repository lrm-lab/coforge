import { useCallback, useMemo, useState, type ReactNode } from "react";

import {
  LazyAgentProfilePanel,
  LazyPersonProfilePanel,
} from "#src/features/agents/profile-panel/lazy-profile-panels";
import type {
  OpenAgentProfile,
  OpenPersonProfile,
} from "#src/features/agents/profile-panel/open-agent-profile";
import type { AgentProfileTab } from "#src/features/agents/profile-panel/profile-panel-search";

type Profile = { kind: "agent" | "person"; id: string; tab?: AgentProfileTab };

export function useTaskPopupProfile(taskId: string | undefined): {
  openers: { onOpenAgentProfile: OpenAgentProfile; onOpenPersonProfile: OpenPersonProfile };
  open: boolean;
  close: () => void;
  panel: ReactNode;
} {
  const [opened, setOpened] = useState<Profile & { taskId: string }>();
  const profile = opened && opened.taskId === taskId ? opened : undefined;
  const close = useCallback(() => setOpened(undefined), []);
  const open = useCallback(
    (next: Profile) => {
      if (!taskId) return;
      setOpened({ ...next, taskId });
    },
    [taskId],
  );
  const onTabChange = useCallback((tab: AgentProfileTab) => {
    setOpened((current) => (current ? { ...current, tab } : current));
  }, []);
  const openers = useMemo(
    () => ({
      onOpenAgentProfile: (id: string, tab?: AgentProfileTab) => open({ kind: "agent", id, tab }),
      onOpenPersonProfile: (id: string) => open({ kind: "person", id }),
    }),
    [open],
  );
  const panel = profile ? (
    profile.kind === "agent" ? (
      <LazyAgentProfilePanel
        key={profile.id}
        agentId={profile.id}
        requestedTab={profile.tab}
        onTabChange={onTabChange}
        onClose={close}
      />
    ) : (
      <LazyPersonProfilePanel
        key={profile.id}
        userId={profile.id}
        onClose={close}
        onOpenAgent={(id) => open({ kind: "agent", id })}
      />
    )
  ) : null;
  return {
    openers,
    open: Boolean(profile),
    close,
    panel,
  };
}
