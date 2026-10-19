import { getRouteApi } from "@tanstack/react-router";
import { MessageChatSquare } from "@untitledui/icons";

import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "#src/components/ui/empty";
import {
  pickConversationPageSearch,
  type HostedConversationTarget,
} from "#src/features/conversations/conversation-page-search";
import {
  HOSTED_CONVERSATION_PANE_CLASS,
  HostedConversationPane,
} from "#src/features/conversations/hosted-conversation-pane";
import { m } from "#src/paraglide/messages";

const activityRoute = getRouteApi("/w/$workspaceSlug/activity");

/**
 * The conversation a card opened, beside the Activity list, as Chat opens it
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

/** The pane while no card is open: opening a card reads it, so none opens on its own. */
export function ActivityConversationEmpty() {
  return (
    <section aria-label={m.activity_conversation_pane()} className={HOSTED_CONVERSATION_PANE_CLASS}>
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <MessageChatSquare aria-hidden="true" />
          </EmptyMedia>
          <EmptyTitle>{m.activity_conversation_empty_title()}</EmptyTitle>
          <EmptyDescription>{m.activity_conversation_empty_description()}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    </section>
  );
}
