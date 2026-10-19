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
 * The conversation a row opened, as Chat opens it (`HostedConversationPane`), its back arrow
 * (`ConversationListButton`) calling `onClose`. The page's own address state comes out of the
 * Activity URL, shared structurally: switching the list's view does not re-render the conversation.
 */
export function ActivityConversationPane({
  target,
  onClose,
}: {
  target: HostedConversationTarget;
  onClose: () => void;
}) {
  const search = activityRoute.useSearch({
    select: pickConversationPageSearch,
    structuralSharing: true,
  });
  // The list is always mounted, so nothing closes it.
  const listControls = useMemo(
    () => ({ showList: onClose, closeList: () => {}, detailVisible: true }),
    [onClose],
  );
  return (
    <ConversationListContext value={listControls}>
      <HostedConversationPane
        target={target}
        search={search}
        label={m.activity_conversation_pane()}
        loadingLabel={m.activity_conversation_loading()}
        failedText={m.activity_conversation_failed()}
        standaloneBelowLg
      />
    </ConversationListContext>
  );
}
