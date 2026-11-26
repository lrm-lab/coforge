import { memo, Suspense, useContext, useMemo, useState, type Ref } from "react";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { CatchBoundary, ClientOnly } from "@tanstack/react-router";
import { AlertCircle } from "@untitledui/icons";

import { EmptyState, RetryButton } from "#src/components/ui/empty";
import { EmptyIcon } from "#src/components/ui/empty-icon";
import { useCurrentWorkspaceId } from "#src/features/agents/workspace-agents-realtime";
import { m } from "#src/paraglide/messages";
import { cx } from "#src/utils/cx";
import {
  ConversationBackHeader,
  ConversationListContext,
  LIST_BESIDE_CLASSES,
} from "./conversation-list-button";
import { ConversationHostProvider } from "./conversation-host";
import { ConversationPage } from "./conversation-page";
import { windowReplacement } from "./conversation-page-loader";
import type { ConversationPageSearch, HostedConversationTarget } from "./conversation-page-search";
import { ConversationPending } from "./conversation-pending";
import { OpenUnreadHintContext } from "./use-conversation-open";
import { channelNamesQuery, savedMessagesQuery } from "./conversation-queries";
import { NO_SAVED } from "./saved-messages-collection";
import { readChatList } from "./chat-lists-reader";

const HOSTED_CONVERSATION_PANE_CLASS = "flex min-h-0 min-w-0 flex-1 flex-col bg-primary";

export const HostedConversationPane = memo(function HostedConversationPane({
  target,
  search,
  label,
  loadingLabel,
  failedText,
  onJumpMessageConsumed,
  borderless = false,
  ref,
}: {
  target: HostedConversationTarget;
  search: ConversationPageSearch;
  label: string;
  loadingLabel: string;
  failedText: string;
  onJumpMessageConsumed?: () => void;
  borderless?: boolean;
  ref?: Ref<HTMLElement>;
}) {
  const [failed, setFailed] = useState(false);
  const [retryCount, setRetryCount] = useState(0);
  const list = useContext(ConversationListContext);
  return (
    <section
      ref={ref}
      aria-label={label}
      className={cx(
        HOSTED_CONVERSATION_PANE_CLASS,
        !borderless && "border-l border-secondary",
        !borderless && list && LIST_BESIDE_CLASSES[list.listBesideFrom].pane,
      )}
    >
      {failed ? (
        <>
          {list && (
            <ConversationBackHeader
              className={LIST_BESIDE_CLASSES[list.listBesideFrom].narrowOnly}
            />
          )}
          <EmptyState
            role="alert"
            picture={<EmptyIcon icon={AlertCircle} />}
            title={failedText}
            description={m.empty_load_failed_safe()}
            primaryAction={
              <RetryButton
                onPress={() => {
                  setFailed(false);
                  setRetryCount((n) => n + 1);
                }}
              />
            }
          />
        </>
      ) : (
        <ClientOnly>
          <CatchBoundary
            getResetKey={() => `${target.kind}:${target.id}:${retryCount}`}
            errorComponent={() => null}
            onCatch={() => setFailed(true)}
          >
            <Suspense fallback={<ConversationPending label={loadingLabel} />}>
              <HostedConversation
                target={target}
                search={search}
                onJumpMessageConsumed={onJumpMessageConsumed}
              />
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
  onJumpMessageConsumed,
}: {
  target: HostedConversationTarget;
  search: ConversationPageSearch;
  onJumpMessageConsumed?: () => void;
}) {
  const workspaceId = useCurrentWorkspaceId() ?? "";
  // Opened on a message its window lacks, or has yet to read: the pane shows its loading state
  // until the window around that message is in, so its first picture is where it lands, under the
  // divider (task #358). Only as it opens: once open, the pane stays on screen.
  const queryClient = useQueryClient();
  const [replacing] = useState(() => windowReplacement(queryClient, target.id));
  if (replacing) throw replacing;
  const channels = useSuspenseQuery(channelNamesQuery(workspaceId)).data;
  // The viewer's Saved stars, as Chat shows them; a failed read leaves none, as in Chat.
  useSuspenseQuery({
    ...savedMessagesQuery(workspaceId),
    queryFn: () => readChatList("saved").catch(() => NO_SAVED),
  });
  // Where the opener read the viewer's unread starts, for the divider's first picture (task #102).
  const { id, unreadFrom } = target;
  const unreadHint = useMemo(
    () => (unreadFrom ? { conversationId: id, messageId: unreadFrom } : null),
    [id, unreadFrom],
  );
  return (
    <ConversationHostProvider channels={channels}>
      <OpenUnreadHintContext value={unreadHint}>
        <ConversationPage
          target={{ kind: target.kind, id: target.id }}
          search={search}
          hosted
          jumpMessage={target.messageId}
          onJumpMessageConsumed={onJumpMessageConsumed}
        />
      </OpenUnreadHintContext>
    </ConversationHostProvider>
  );
}
