import { useCallback, useEffect, useMemo } from "react";
import { createFileRoute, getRouteApi, useNavigate } from "@tanstack/react-router";

import {
  conversationPageLoaderDeps,
  loadHostedConversation,
} from "#src/features/conversations/conversation-page-loader";
import {
  hostedConversationOpenParam,
  messageHash,
  parseHostedConversation,
  type HostedConversationTarget,
} from "#src/features/conversations/conversation-page-search";
import { parseScope, type SearchFilters } from "#src/features/search/search-filters";
import { writeLastSearch } from "#src/features/search/search-memory";
import { SearchPage } from "#src/features/search/search-page";
import { searchPageSearchSchema, searchQuerySchema } from "#src/features/search/search.schemas";

const appRoute = getRouteApi("/w/$workspaceSlug");

export const Route = createFileRoute("/w/$workspaceSlug/search")({
  validateSearch: searchPageSearchSchema,
  // The loader reads only what `loaderDeps` names; typing a query never reruns it.
  staleTime: Infinity,
  loaderDeps: ({ search }) => ({
    open: search.open,
    ...conversationPageLoaderDeps({ ...search, message: search.msg }),
  }),
  loader: async ({ context: { queryClient }, parentMatchPromise, deps, cause }) => {
    const target = parseHostedConversation(deps.open);
    if (!target) return;
    // The previewed conversation opens as Chat opens it: its window, Tasks counts, the channel
    // names and Saved are read first on arrival, in the browser (`loadHostedConversation` reads
    // nothing on the server, so a first load's document holds no message: the preview reads it
    // once it renders). Switching the preview while on search only starts the reads, so the
    // preview shows its loading state at once. A failed read is left to the preview, which says so.
    const page = loadHostedConversation(queryClient, target, deps, {
      cause,
      workspaceId: () =>
        parentMatchPromise.then((parent) => parent.loaderData?.currentWorkspace?.id ?? ""),
    }).catch(() => undefined);
    if (cause !== "stay") await page;
  },
  component: SearchRoute,
});

function SearchRoute() {
  const { q, senderId, scope, channelId, range, sort, defer, open, msg } = Route.useSearch();
  const { currentWorkspace, timeZone, user } = appRoute.useLoaderData();
  const workspaceId = currentWorkspace?.id;
  // The search as the URL holds it becomes the last search, for Cmd/Ctrl+K to reopen.
  useEffect(() => {
    if (workspaceId)
      writeLastSearch(workspaceId, user.id, { q, senderId, scope, channelId, range, sort });
  }, [workspaceId, user.id, q, senderId, scope, channelId, range, sort]);
  const navigate = useNavigate({ from: Route.fullPath });
  const filters = useMemo<SearchFilters>(
    () => ({ senderId, scope: parseScope(scope), channelId, range, sort }),
    [senderId, scope, channelId, range, sort],
  );
  // Typing replaces the entry instead of stacking one history step per pause.
  const onQueryChange = useCallback(
    (next: string) =>
      void navigate({
        search: (previous) => ({ ...previous, q: next.trim() ? next : undefined }),
        replace: true,
      }),
    [navigate],
  );
  // A filter change is a step Back can undo.
  const onFiltersChange = useCallback(
    (next: SearchFilters) =>
      void navigate({
        search: (previous) => ({
          q: previous.q,
          senderId: next.senderId,
          scope: next.scope?.join(","),
          channelId: next.channelId,
          range: next.range,
          sort: next.sort,
        }),
      }),
    [navigate],
  );
  // The preview lives in the URL, so a reload or a shared link reopens it; switching it replaces
  // the entry rather than stacking history. Only the search's own fields carry over: the previous
  // conversation's tab, board view, thread, Task popup and Agent profile close with it, and a
  // thread reply opens its thread, as Chat opens one.
  const preview = useMemo(() => parseHostedConversation(open, msg), [open, msg]);
  const onPreviewChange = useCallback(
    (next: HostedConversationTarget | undefined) =>
      void navigate({
        search: (previous) => ({
          ...searchQuerySchema.parse(previous),
          open: next ? hostedConversationOpenParam(next) : undefined,
          msg: next?.messageId,
          threadRootId: next?.threadRootId,
        }),
        hash: next?.threadReplyId ? messageHash(next.threadReplyId) : undefined,
        replace: true,
      }),
    [navigate],
  );
  if (!currentWorkspace) return null;
  return (
    <SearchPage
      workspaceId={currentWorkspace.id}
      viewerId={user.id}
      deferred={defer === "1"}
      timeZone={timeZone}
      query={q ?? ""}
      filters={filters}
      onQueryChange={onQueryChange}
      onFiltersChange={onFiltersChange}
      preview={preview}
      onPreviewChange={onPreviewChange}
    />
  );
}
