import { useEffect, useEffectEvent } from "react";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";

import { parseHostedConversation } from "#src/features/conversations/conversation-page-search";
import { activityChatLink } from "#src/features/inbox/activity-open-target";
import { useOpenSearch } from "#src/features/search/search-dialog-context";
import { parseScope } from "#src/features/search/search-filters";
import { searchQuerySchema } from "#src/features/search/search.schemas";

/**
 * An address from before search became a dialog: opens the dialog with its search, over the
 * Workspace. One that named the conversation the old page previewed (`open`, at message `msg`)
 * opens that conversation at the message instead, as its links still promise; a conversation the
 * viewer cannot open shows the conversation page's own "can't open" state.
 */
export const Route = createFileRoute("/w/$workspaceSlug/search")({
  validateSearch: searchQuerySchema,
  beforeLoad: ({ search, params }) => {
    const target = parseHostedConversation(search.open, search.msg);
    if (target)
      throw redirect({ ...activityChatLink(params.workspaceSlug, target), replace: true });
  },
  component: SearchAddress,
});

function SearchAddress() {
  const { q, senderId, scope, channelId, range, sort, defer } = Route.useSearch();
  const { workspaceSlug } = Route.useParams();
  const openSearch = useOpenSearch();
  const navigate = useNavigate();
  const openAddress = useEffectEvent(() => {
    openSearch({
      query: q,
      filters: { senderId, scope: parseScope(scope), channelId, range, sort },
      deferred: defer === "1",
    });
    void navigate({ to: "/w/$workspaceSlug", params: { workspaceSlug }, replace: true });
  });
  useEffect(() => openAddress(), []);
  return null;
}
