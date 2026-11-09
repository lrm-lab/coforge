import { createContext, useContext } from "react";

import type { OpenAgentProfile } from "./profile-panel/open-agent-profile";

/** A channel's Agent members, as the page showing it knows them. */
export type ChannelAgents = {
  conversationId: string;
  agentIds: readonly string[];
  onOpenAgentProfile?: OpenAgentProfile;
};

/** Provided by a channel's page; absent in a DM and for a viewer who is not a member. */
export const ChannelAgentsContext = createContext<ChannelAgents | undefined>(undefined);

/**
 * The channel's Agents for the composer line of that channel's main stream. A thread pane or a
 * Task's discussion on the same page shows typing only, so it gets nothing.
 */
export function useChannelAgents(conversationId: string, threadRootId: string | null) {
  const channel = useContext(ChannelAgentsContext);
  return channel?.conversationId === conversationId && threadRootId === null ? channel : undefined;
}
