import { memo, Suspense, useState } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { CatchBoundary, ClientOnly, getRouteApi } from "@tanstack/react-router";
import { MessageChatSquare } from "@untitledui/icons";

import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "#src/components/ui/empty";
import { Skeleton } from "#src/components/ui/skeleton";
import { useCurrentWorkspaceId } from "#src/features/agents/workspace-agents-realtime";
import { ConversationHostProvider } from "#src/features/conversations/conversation-host";
import { ConversationPage } from "#src/features/conversations/conversation-page";
import type { ConversationPageTarget } from "#src/features/conversations/conversation-page-loader";
import { pickConversationPageSearch } from "#src/features/conversations/conversation-page-search";
import {
  channelNamesQuery,
  savedMessagesQuery,
} from "#src/features/conversations/conversation-queries";
import { NO_SAVED } from "#src/features/conversations/saved-messages-collection";
import { listSavedMessages } from "#src/features/conversations/saved-messages.functions";
import { m } from "#src/paraglide/messages";

const activityRoute = getRouteApi("/w/$workspaceSlug/activity");

const PANE_CLASS_NAME = "flex min-h-0 min-w-0 flex-1 flex-col border-l border-secondary bg-primary";

/**
 * The conversation a card opened, beside the Activity list, exactly as Chat opens it: the same
 * page (`ConversationPage`) with its tabs, stream positioned at the message, composer, threads,
 * Task board and files, and reading it as Chat does. Keyed by conversation where it is rendered,
 * so another conversation starts fresh. Memoized: a list refresh re-renders the list, not the
 * conversation.
 */
export const ActivityConversationPane = memo(function ActivityConversationPane({
  target,
  jumpMessage,
}: {
  target: ConversationPageTarget;
  /** The message the stream lands on. */
  jumpMessage: string | undefined;
}) {
  const [failed, setFailed] = useState(false);
  return (
    <section aria-label={m.activity_conversation_pane()} className={PANE_CLASS_NAME}>
      {failed ? (
        <p role="alert" className="p-4 text-sm text-error-primary">
          {m.activity_conversation_failed()}
        </p>
      ) : (
        <ClientOnly>
          <CatchBoundary
            getResetKey={() => `${target.kind}:${target.id}`}
            errorComponent={() => null}
            onCatch={() => setFailed(true)}
          >
            <Suspense fallback={<ActivityConversationSkeleton />}>
              <ActivityConversationPage target={target} jumpMessage={jumpMessage} />
            </Suspense>
          </CatchBoundary>
        </ClientOnly>
      )}
    </section>
  );
});

/** The pane while no card is open: opening a card reads it, so none opens on its own. */
export function ActivityConversationEmpty() {
  return (
    <section aria-label={m.activity_conversation_pane()} className={PANE_CLASS_NAME}>
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

/**
 * The conversation page itself, under what Chat's layout gives it and the Activity page supplies:
 * the viewer's Saved list, the Workspace's channels (the Activity loader has read them) and the
 * page's own address state out of the Activity URL.
 */
function ActivityConversationPage({
  target,
  jumpMessage,
}: {
  target: ConversationPageTarget;
  jumpMessage: string | undefined;
}) {
  const workspaceId = useCurrentWorkspaceId() ?? "";
  const channels = useSuspenseQuery(channelNamesQuery(workspaceId)).data;
  // The viewer's Saved stars, as Chat shows them; a failed read leaves none, as in Chat.
  useSuspenseQuery({
    ...savedMessagesQuery(workspaceId),
    queryFn: () => listSavedMessages().catch(() => NO_SAVED),
  });
  // Only the page's own fields, shared structurally: switching the list's view does not
  // re-render the page.
  const search = activityRoute.useSearch({
    select: pickConversationPageSearch,
    structuralSharing: true,
  });
  return (
    <ConversationHostProvider channels={channels}>
      <ConversationPage
        target={{ kind: target.kind, id: target.id }}
        search={search}
        jumpMessage={jumpMessage}
      />
    </ConversationHostProvider>
  );
}

/** Message-shaped placeholders while the conversation loads. */
function ActivityConversationSkeleton() {
  return (
    <div
      role="status"
      aria-label={m.activity_conversation_loading()}
      className="flex flex-col gap-4 p-4"
    >
      {Array.from({ length: 6 }, (_, index) => (
        <div key={index} className="flex gap-3">
          <Skeleton className="size-8 shrink-0 rounded-full" />
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton className="h-3 w-32" />
            <Skeleton className="h-3 w-full" />
          </div>
        </div>
      ))}
    </div>
  );
}
