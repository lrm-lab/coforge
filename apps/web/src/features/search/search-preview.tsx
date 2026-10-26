import type { Ref } from "react";
import { getRouteApi } from "@tanstack/react-router";

import {
  MountedListControls,
  type ListBesideFrom,
} from "#src/features/conversations/conversation-list-button";
import {
  pickConversationPageSearch,
  type HostedConversationTarget,
} from "#src/features/conversations/conversation-page-search";
import { HostedConversationPane } from "#src/features/conversations/hosted-conversation-pane";
import { m } from "#src/paraglide/messages";

const searchRoute = getRouteApi("/w/$workspaceSlug/search");

/** From `md` the preview sits beside the results; below, it takes their place. */
export const SEARCH_LIST_BESIDE_FROM: ListBesideFrom = "md";

/**
 * A result's conversation beside the search results, as Chat opens it (`HostedConversationPane`);
 * below `md` in their place, its back arrow (`ConversationListButton`) calling `onClose`. The
 * page's own address state comes out of the search URL, shared structurally: typing a query does
 * not re-render the conversation.
 */
export function SearchPreview({
  target,
  onClose,
  ref,
}: {
  target: HostedConversationTarget;
  onClose: () => void;
  ref?: Ref<HTMLElement>;
}) {
  const search = searchRoute.useSearch({
    select: pickConversationPageSearch,
    structuralSharing: true,
  });
  return (
    <MountedListControls
      listBesideFrom={SEARCH_LIST_BESIDE_FROM}
      backLabel={m.search_back_to_results()}
      onClose={onClose}
    >
      <HostedConversationPane
        ref={ref}
        target={target}
        search={search}
        label={m.search_preview()}
        loadingLabel={m.search_preview_loading()}
        failedText={m.search_preview_failed()}
      />
    </MountedListControls>
  );
}
