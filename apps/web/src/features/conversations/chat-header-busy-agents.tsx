import { useMemo } from "react";

import { BusyAgentsStage } from "#src/features/agents/busy-agents-stage";
import { useOpenHeaderAgent } from "#src/features/agents/profile-panel/open-agent-profile";
import { listedDirectAgentIds, type directListsOf } from "./sidebar-rows";

/**
 * The busy Agents in the Chat list's header. The Agents the viewer has an open Direct message with
 * come first, and opening one outside a conversation goes to that Direct message
 * (`listedDirectAgentIds`).
 */
export function ChatHeaderBusyAgents({
  directs,
  onConversationPage,
}: {
  directs: ReturnType<typeof directListsOf>;
  onConversationPage: boolean;
}) {
  const directConversations = useMemo(() => listedDirectAgentIds(directs), [directs]);
  const directAgentIds = useMemo(() => new Set(directConversations.keys()), [directConversations]);
  const openAgent = useOpenHeaderAgent(onConversationPage, directConversations);
  return <BusyAgentsStage directAgentIds={directAgentIds} onOpenAgent={openAgent} />;
}
