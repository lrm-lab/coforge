import { getRouteApi } from "@tanstack/react-router";

import {
  pickConversationPageSearch,
  type HostedConversationTarget,
} from "#src/features/conversations/conversation-page-search";
import { HostedConversationPane } from "#src/features/conversations/hosted-conversation-pane";
import { m } from "#src/paraglide/messages";

const activityRoute = getRouteApi("/w/$workspaceSlug/activity");

/**
 * The conversation a row opened, beside the Activity list, as Chat opens it
 * (`HostedConversationPane`). The page's own address state comes out of the Activity URL, shared
 * structurally: switching the list's view does not re-render the conversation.
 */
export function ActivityConversationPane({ target }: { target: HostedConversationTarget }) {
  const search = activityRoute.useSearch({
    select: pickConversationPageSearch,
    structuralSharing: true,
  });
  return (
    <HostedConversationPane
      target={target}
      search={search}
      label={m.activity_conversation_pane()}
      loadingLabel={m.activity_conversation_loading()}
      failedText={m.activity_conversation_failed()}
    />
  );
}
