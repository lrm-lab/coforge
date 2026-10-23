import { useCallback, useMemo } from "react";
import { getRouteApi } from "@tanstack/react-router";

import { ConversationListContext } from "#src/features/conversations/conversation-list-button";
import {
  pickConversationPageSearch,
  type HostedConversationTarget,
} from "#src/features/conversations/conversation-page-search";
import { hostedLandingAfterConsume } from "#src/features/conversations/conversation-thread-search";
import { HostedConversationPane } from "#src/features/conversations/hosted-conversation-pane";
import { StandaloneThreadContext } from "#src/features/conversations/standalone-thread";
import { m } from "#src/paraglide/messages";

const activityRoute = getRouteApi("/w/$workspaceSlug/activity");

/**
 * The conversation a row opened, as Chat opens it (`HostedConversationPane`), its back arrow
 * (`ConversationListButton`) calling `onClose`; a thread opened alone (`threadAlone`) shows only
 * the thread, whose close is the pane's and whose "View in channel" opens the conversation at the
 * thread's root (`onOpen`). The page's own address state comes out of the Activity URL, shared
 * structurally: switching the list's view does not re-render the conversation.
 */
export function ActivityConversationPane({
  target,
  onOpen,
  onClose,
}: {
  target: HostedConversationTarget;
  onOpen: (target: HostedConversationTarget) => void;
  onClose: () => void;
}) {
  const { kind, id } = target;
  const onViewInConversation = useCallback(
    (rootId: string) => onOpen({ kind, id, messageId: rootId }),
    [onOpen, kind, id],
  );
  const search = activityRoute.useSearch({
    select: pickConversationPageSearch,
    structuralSharing: true,
  });
  const navigate = activityRoute.useNavigate();
  // A conversation landing is one-shot. Leaving `msg` set makes the pane jump back to it every
  // time Chat/Tasks remounts the stream. A standalone thread keeps `msg`: it is the root.
  const clearLanding = useCallback(() => {
    void navigate({
      replace: true,
      resetScroll: false,
      search: (previous) => ({ ...previous, msg: undefined }),
    });
  }, [navigate]);
  const onJumpMessageConsumed =
    hostedLandingAfterConsume(Boolean(target.threadAlone)) === "clear" ? clearLanding : undefined;
  // The list is always mounted, so nothing closes it.
  const listControls = useMemo(
    () => ({ showList: onClose, closeList: () => {}, detailVisible: true }),
    [onClose],
  );
  // Always provided, so showing the conversation in place of the thread keeps the pane mounted.
  const rootId = target.threadAlone ? target.messageId : undefined;
  const standaloneThread = useMemo(
    () => (rootId ? { rootId, onClose, onViewInConversation } : null),
    [rootId, onClose, onViewInConversation],
  );
  return (
    <ConversationListContext value={listControls}>
      <StandaloneThreadContext value={standaloneThread}>
        <HostedConversationPane
          target={target}
          search={search}
          label={m.activity_conversation_pane()}
          loadingLabel={m.activity_conversation_loading()}
          failedText={m.activity_conversation_failed()}
          onJumpMessageConsumed={onJumpMessageConsumed}
          standaloneBelowLg
        />
      </StandaloneThreadContext>
    </ConversationListContext>
  );
}
