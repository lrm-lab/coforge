import type { Ref } from "react";
import { getRouteApi } from "@tanstack/react-router";

import {
  pickConversationPageSearch,
  type HostedConversationTarget,
} from "#src/features/conversations/conversation-page-search";
import { HostedConversationPane } from "#src/features/conversations/hosted-conversation-pane";
import { m } from "#src/paraglide/messages";

const searchRoute = getRouteApi("/w/$workspaceSlug/search");

/**
 * A result's conversation beside the search results, as Chat opens it (`HostedConversationPane`).
 * The page's own address state comes out of the search URL, shared structurally: typing a query
 * does not re-render the conversation.
 */
export function SearchPreview({
  target,
  ref,
}: {
  target: HostedConversationTarget;
  ref?: Ref<HTMLElement>;
}) {
  const search = searchRoute.useSearch({
    select: pickConversationPageSearch,
    structuralSharing: true,
  });
  return (
    <HostedConversationPane
      ref={ref}
      target={target}
      search={search}
      label={m.search_preview()}
      loadingLabel={m.search_preview_loading()}
      failedText={m.search_preview_failed()}
    />
  );
}
