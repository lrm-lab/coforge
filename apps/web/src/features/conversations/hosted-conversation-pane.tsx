import { memo, Suspense, useContext, useState, type Ref } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { CatchBoundary, ClientOnly } from "@tanstack/react-router";

import { useCurrentWorkspaceId } from "#src/features/agents/workspace-agents-realtime";
import { cx } from "#src/utils/cx";
import { ConversationBackHeader, ConversationListContext } from "./conversation-list-button";
import { ConversationHostProvider } from "./conversation-host";
import { ConversationPage } from "./conversation-page";
import type { ConversationPageSearch, HostedConversationTarget } from "./conversation-page-search";
import { ConversationPending } from "./conversation-pending";
import { channelNamesQuery, savedMessagesQuery } from "./conversation-queries";
import { NO_SAVED } from "./saved-messages-collection";
import { listSavedMessages } from "./saved-messages.functions";

/** The pane's column beside its host's content. */
const HOSTED_CONVERSATION_PANE_CLASS =
  "flex min-h-0 min-w-0 flex-1 flex-col border-l border-secondary bg-primary";

/**
 * A conversation beside a page's own content, exactly as Chat opens it: the same page
 * (`ConversationPage`) with its tabs, stream positioned at the target's message, composer, threads,
 * Task board and files, and reading it as Chat does. The host reads its address state
 * (`pickConversationPageSearch`, shared structurally) and keys the pane by conversation, so another
 * conversation starts fresh. Memoized: a re-render of the host's content leaves the conversation be.
 */
export const HostedConversationPane = memo(function HostedConversationPane({
  target,
  search,
  label,
  loadingLabel,
  failedText,
  standaloneBelowLg = false,
  ref,
}: {
  target: HostedConversationTarget;
  search: ConversationPageSearch;
  /** The pane's accessible name. */
  label: string;
  loadingLabel: string;
  /** Said in place of the conversation when it fails to load. */
  failedText: string;
  /** The pane fills the page below `lg`, with no list beside it (so no divider there). */
  standaloneBelowLg?: boolean;
  ref?: Ref<HTMLElement>;
}) {
  const [failed, setFailed] = useState(false);
  // Only a host with a list to go back to (Activity) has a back arrow over the failure.
  const backToList = useContext(ConversationListContext) !== null;
  return (
    <section
      ref={ref}
      aria-label={label}
      className={cx(HOSTED_CONVERSATION_PANE_CLASS, standaloneBelowLg && "max-lg:border-l-0")}
    >
      {failed ? (
        <>
          {backToList && <ConversationBackHeader />}
          <p role="alert" className="p-4 text-sm text-error-primary">
            {failedText}
          </p>
        </>
      ) : (
        <ClientOnly>
          <CatchBoundary
            getResetKey={() => `${target.kind}:${target.id}`}
            errorComponent={() => null}
            onCatch={() => setFailed(true)}
          >
            <Suspense fallback={<ConversationPending label={loadingLabel} />}>
              <HostedConversation target={target} search={search} />
            </Suspense>
          </CatchBoundary>
        </ClientOnly>
      )}
    </section>
  );
});

/**
 * The conversation page itself, under what Chat's layout gives it: the viewer's Saved list and the
 * Workspace's channels (`loadHostedConversation` has read both).
 */
function HostedConversation({
  target,
  search,
}: {
  target: HostedConversationTarget;
  search: ConversationPageSearch;
}) {
  const workspaceId = useCurrentWorkspaceId() ?? "";
  const channels = useSuspenseQuery(channelNamesQuery(workspaceId)).data;
  // The viewer's Saved stars, as Chat shows them; a failed read leaves none, as in Chat.
  useSuspenseQuery({
    ...savedMessagesQuery(workspaceId),
    queryFn: () => listSavedMessages().catch(() => NO_SAVED),
  });
  return (
    <ConversationHostProvider channels={channels}>
      <ConversationPage
        target={{ kind: target.kind, id: target.id }}
        search={search}
        jumpMessage={target.messageId}
      />
    </ConversationHostProvider>
  );
}
