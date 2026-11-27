import { useNavigate, useRouter } from "@tanstack/react-router";

import { useLatestCallback } from "#src/hooks/use-latest-callback";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import {
  agentIdFromProfileParam,
  agentProfileSearchBase,
  formatAgentProfileParam,
  formatPersonProfileParam,
  personIdFromProfileParam,
  type AgentProfileTab,
} from "./profile-panel-search";

export type OpenAgentProfile = (agentId: string, tab?: AgentProfileTab) => void;

export type OpenPersonProfile = (userId: string) => void;

export function useOpenAgentProfile() {
  const router = useRouter();
  const openAgentProfile: OpenAgentProfile = (agentId, tab) =>
    void router.navigate({
      to: ".",
      search: (previous) => ({
        ...agentProfileSearchBase(previous),
        profile: formatAgentProfileParam(agentId),
        ...(tab ? { agentTab: tab } : {}),
      }),
    });
  const openPersonProfile: OpenPersonProfile = (userId) =>
    void router.navigate({
      to: ".",
      search: (previous) => {
        const { agentTab: _agentTab, ...rest } = agentProfileSearchBase(previous);
        return { ...rest, profile: formatPersonProfileParam(userId) };
      },
    });
  const setAgentProfileTab = (tab: AgentProfileTab) =>
    void router.navigate({
      to: ".",
      replace: true,
      search: (previous) => ({ ...previous, agentTab: tab }),
    });
  const closeAgentProfile = () =>
    void router.navigate({
      to: ".",
      replace: true,
      search: (previous) => {
        const { profile: _profile, agentTab: _agentTab, ...rest } = previous;
        return rest;
      },
    });
  return { openAgentProfile, openPersonProfile, setAgentProfileTab, closeAgentProfile };
}

export function useConversationAgentProfile({
  profile,
  agentTab,
}: {
  profile?: string;
  agentTab?: AgentProfileTab;
}) {
  const { openAgentProfile, openPersonProfile, setAgentProfileTab, closeAgentProfile } =
    useOpenAgentProfile();
  return {
    onOpenAgentProfile: openAgentProfile,
    onOpenPersonProfile: openPersonProfile,
    agentProfile: {
      agentId: agentIdFromProfileParam(profile),
      tab: agentTab,
      personId: personIdFromProfileParam(profile),
    },
    onAgentProfileTabChange: setAgentProfileTab,
    onCloseAgentProfile: closeAgentProfile,
  };
}

export function useOpenHeaderAgent(
  onConversationPage: boolean,
  directConversations: ReadonlyMap<string, string>,
): OpenAgentProfile {
  const { openAgentProfile } = useOpenAgentProfile();
  const navigate = useNavigate();
  const workspaceSlug = useWorkspaceSlug();
  const open: OpenAgentProfile = (agentId, tab) => {
    if (onConversationPage) return openAgentProfile(agentId, tab);
    const dmId = directConversations.get(agentId);
    if (dmId)
      return void navigate({
        to: "/w/$workspaceSlug/dm/$dmId",
        params: { workspaceSlug, dmId },
        search: { profile: formatAgentProfileParam(agentId), ...(tab ? { agentTab: tab } : {}) },
      });
    void navigate({
      to: "/w/$workspaceSlug/agent/$agentId",
      params: { workspaceSlug, agentId },
      search: tab ? { agentTab: tab } : {},
    });
  };
  return useLatestCallback(open);
}
