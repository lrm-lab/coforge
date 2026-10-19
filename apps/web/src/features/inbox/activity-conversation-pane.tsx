import { useMemo } from "react";
import { getRouteApi } from "@tanstack/react-router";

import { ConversationListContext } from "#src/features/conversations/conversation-list-button";
import {
  pickConversationPageSearch,
  type HostedConversationTarget,
} from "#src/features/conversations/conversation-page-search";
import { HostedConversationPane } from "#src/features/conversations/hosted-conversation-pane";
import { m } from "#src/paraglide/messages";

const activityRoute = getRouteApi("/w/$workspaceSlug/activity");

/**
 * The conversation a row opened, beside the Activity list from `lg` and in its place below, as
 * Chat opens it (`HostedConversationPane`). The page's own address state comes out of the Activity
 * URL, shared structurally: switching the list's view does not re-render the conversation. Below
 * `lg` its header's back arrow (`ConversationListButton`) returns to the list in its current view,
 * closing the conversation and everything it had open.
 */
export function ActivityConversationPane({ target }: { target: HostedConversationTarget }) {
  const search = activityRoute.useSearch({
    select: pickConversationPageSearch,
    structuralSharing: true,
  });
  const navigate = activityRoute.useNavigate();
  // Replaces the entry, as opening one does. The list is always mounted, so nothing closes it.
  const listControls = useMemo(
    () => ({
      showList: () =>
        void navigate({ search: (previous) => ({ filter: previous.filter }), replace: true }),
      closeList: () => {},
      detailVisible: true,
    }),
    [navigate],
  );
  return (
    <ConversationListContext value={listControls}>
      <HostedConversationPane
        target={target}
        search={search}
        label={m.activity_conversation_pane()}
        loadingLabel={m.activity_conversation_loading()}
        failedText={m.activity_conversation_failed()}
        // Below `lg` the pane takes the list's place: nothing beside it to divide from.
        className="max-lg:border-l-0"
      />
    </ConversationListContext>
  );
}
