import { useEffect } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";

import { EmptyState } from "#src/components/ui/empty";
import { ChatWireframe } from "#src/components/ui/empty-wireframes";
import {
  useCurrentWorkspaceId,
  useVisibleAgentDirectory,
} from "#src/features/agents/workspace-agents-realtime";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { useBreakpoint } from "#src/hooks/use-breakpoint";
import { m } from "#src/paraglide/messages";
import { ConversationPending } from "./conversation-pending";
import { useDraftsOn } from "./use-drafts-on";
import { useSidebarLists } from "./sidebar-lists";
import {
  conversationAt,
  conversationRoute,
  firstJoinedChannel,
  landingConversation,
  rememberedConversation,
} from "./last-conversation";
import { listedDirectIds } from "./sidebar-rows";

export function EmptyConversation() {
  const { channels, directs } = useSidebarLists();
  const agents = useVisibleAgentDirectory();
  const workspaceId = useCurrentWorkspaceId();
  const workspaceSlug = useWorkspaceSlug();
  const draftsOn = useDraftsOn();
  const desktop = useBreakpoint("lg");
  const navigate = useNavigate();
  const navigating = useRouterState({ select: (state) => state.status === "pending" });
  useEffect(() => {
    if (!desktop || navigating) return;
    const remembered = workspaceId ? rememberedConversation(workspaceId) : undefined;
    if (
      draftsOn === undefined &&
      remembered &&
      "view" in remembered &&
      remembered.view === "drafts"
    )
      return;
    const target = landingConversation(remembered, {
      channels,
      directIds: listedDirectIds(directs, agents),
      draftsOn: draftsOn === true,
    });
    if (target) void navigate({ ...conversationRoute(target, workspaceSlug), replace: true });
  }, [
    desktop,
    navigating,
    workspaceId,
    workspaceSlug,
    channels,
    agents,
    directs,
    draftsOn,
    navigate,
  ]);

  const opening = useRouterState({
    select: (state) => {
      if (state.status !== "pending") return false;
      const target = conversationAt(state.location.pathname);
      return target !== undefined && !("view" in target);
    },
  });
  if (opening || firstJoinedChannel(channels)) return <ConversationPending />;
  return (
    <EmptyState
      size="page"
      className="h-full"
      picture={<ChatWireframe accent={channels.length === 0} />}
      title={m.empty_conversation_none_selected_title()}
      description={m.empty_conversation_none_selected_description()}
    />
  );
}
