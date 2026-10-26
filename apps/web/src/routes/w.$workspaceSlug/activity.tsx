import { useCallback, useEffect, useMemo, useRef } from "react";
import { createFileRoute, useNavigate, useRouter } from "@tanstack/react-router";
import { z } from "zod";

import {
  conversationPageLoaderDeps,
  loadHostedConversation,
} from "#src/features/conversations/conversation-page-loader";
import {
  conversationPageSearchShape,
  hostedConversationOpenParam,
  hostedConversationSearchShape,
  messageHash,
  parseHostedConversation,
  type HostedConversationTarget,
} from "#src/features/conversations/conversation-page-search";
import { PageLoadError } from "#src/features/errors/page-load-error";
import { ActivityInboxPending } from "#src/features/inbox/activity-inbox-pending";
import { ActivityInboxView } from "#src/features/inbox/activity-inbox-view";
import { activityInboxQuery } from "#src/features/inbox/activity-inbox-queries";
import {
  ACTIVITY_INBOX_FILTERS,
  type ActivityInboxFilter,
} from "#src/features/inbox/activity-inbox.schemas";
import { useBreakpoint } from "#src/hooks/use-breakpoint";

export const Route = createFileRoute("/w/$workspaceSlug/activity")({
  // Each field falls back to absent when malformed, so a stale or hand-edited address never
  // breaks the page.
  validateSearch: z.object({
    filter: z.enum(ACTIVITY_INBOX_FILTERS).optional().catch(undefined),
    // The conversation open beside the list.
    ...hostedConversationSearchShape,
    // The open conversation's tab, Task board view and what it has open, as Chat keeps them.
    ...conversationPageSearchShape,
  }),
  loaderDeps: ({ search }) => ({
    filter: search.filter ?? "all",
    open: search.open,
    ...conversationPageLoaderDeps({ ...search, message: search.msg }),
  }),
  // The list lives in the Query cache (live refreshes and paging); the loader only makes the
  // first page of this view ready. Switching views on the page does not wait for it: the cards
  // on screen stay until the next view has loaded.
  loader: async ({ context: { queryClient }, deps, parentMatchPromise, cause }) => {
    const parent = await parentMatchPromise;
    const workspaceId = parent.loaderData?.currentWorkspace?.id;
    if (!workspaceId) return;
    const ready = queryClient.ensureInfiniteQueryData(activityInboxQuery(workspaceId, deps.filter));
    // The open conversation is read as Chat reads it (`loadHostedConversation` reads only in the
    // browser). Opening another card while on Activity only starts the reads, so the pane shows
    // its loading state at once. A failed read is left to the pane, which says so.
    const target = parseHostedConversation(deps.open);
    const conversation =
      target &&
      loadHostedConversation(queryClient, target, deps, {
        cause,
        workspaceId: async () => workspaceId,
      }).catch(() => undefined);
    // A failed list shows inline in the view, which reads the same query.
    if (cause === "stay") void ready.catch(() => undefined);
    else await Promise.all([ready, conversation]);
  },
  pendingComponent: ActivityInboxPending,
  errorComponent: PageLoadError,
  component: ActivityPage,
});

function ActivityPage() {
  // Only what the list and the pane's target read: the pane's own address state is read where it
  // is rendered, so a tab or Task popup change there does not re-render the list.
  const { filter, open, msg, threadRootId } = Route.useSearch({
    select: ({ filter, open, msg, threadRootId }) => ({ filter, open, msg, threadRootId }),
    structuralSharing: true,
  });
  const navigate = useNavigate({ from: Route.fullPath });
  // Switching views keeps the open conversation.
  const onFilterChange = useCallback(
    (next: ActivityInboxFilter) =>
      void navigate({
        search: (previous) => ({ ...previous, filter: next === "all" ? undefined : next }),
        replace: true,
      }),
    [navigate],
  );
  const router = useRouter();
  const wide = useBreakpoint("lg");
  // The list's history entry under a conversation opened from it below `lg`, until the list shows
  // again.
  const listEntry = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (open === undefined) listEntry.current = undefined;
  }, [open]);
  // The open conversation lives in the URL, so a reload or a shared link reopens it. Below `lg` it
  // takes the list's place, so opening it from the list pushes an entry (the phone's back gesture
  // returns to the list); any other open replaces the entry. Only the list's view carries over:
  // the previous conversation's tab, board view, thread, Task popup and Agent profile close with
  // it, and a thread card opens its thread alone (`thread:` in `open`), without the conversation.
  const onOpen = useCallback(
    (next: HostedConversationTarget) => {
      // The committed location, not `open` above: the rows keep this callback across opens, and a
      // second tap before the first open renders must not push again.
      const push = !wide && router.latestLocation.search.open === undefined;
      if (push) listEntry.current = router.history.location.state.__TSR_index;
      void navigate({
        search: (previous) => ({
          filter: previous.filter,
          open: hostedConversationOpenParam(next),
          msg: next.messageId,
          threadRootId: next.threadRootId,
        }),
        hash: next.threadReplyId ? messageHash(next.threadReplyId) : undefined,
        replace: !push,
      });
    },
    [navigate, router, wide],
  );
  // Closing the conversation (its back arrow below `lg`, a thread's close) returns to the list,
  // closing everything the conversation had open: back to the list's entry when the conversation
  // was opened over it (past the entries a thread or profile opened in it pushed), else by
  // replacing the entry with the list in its current view.
  const onClose = useCallback(() => {
    const index = router.history.location.state.__TSR_index;
    if (listEntry.current !== undefined && index > listEntry.current) {
      router.history.go(listEntry.current - index);
      return;
    }
    void navigate({ search: (previous) => ({ filter: previous.filter }), replace: true });
  }, [navigate, router]);
  // Kept by its fields, so the pane keeps its target while the list's view changes. A `thread:`
  // address shows the thread rooted at `msg` alone for as long as `open` says so, whatever else
  // the pane opens over it (a profile, a Task popup); with no root it shows the conversation.
  const opened = useMemo(() => {
    const target = parseHostedConversation(open, msg);
    if (!target) return undefined;
    const threadAlone = target.threadAlone && msg !== undefined;
    return { ...target, threadRootId, threadAlone: threadAlone || undefined };
  }, [open, msg, threadRootId]);
  return (
    <ActivityInboxView
      filter={filter ?? "all"}
      onFilterChange={onFilterChange}
      opened={opened}
      onOpen={onOpen}
      onClose={onClose}
    />
  );
}
