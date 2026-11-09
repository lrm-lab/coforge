import { useEffect, useEffectEvent } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { useOpenSearch } from "#src/features/search/search-dialog-context";
import { parseScope } from "#src/features/search/search-filters";
import { searchQuerySchema } from "#src/features/search/search.schemas";

/** An address from before search became a dialog: opens the dialog with its search, over the Workspace. */
export const Route = createFileRoute("/w/$workspaceSlug/search")({
  validateSearch: searchQuerySchema,
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
