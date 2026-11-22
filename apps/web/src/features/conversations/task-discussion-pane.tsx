import { useMemo, type ComponentProps } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ConversationTaskDemand } from "#src/features/tasks/conversation-task-demand";
import { replyToTask } from "#src/features/tasks/task-conversation.functions";
import { taskFollowQueryKey } from "#src/features/tasks/task-follow";
import { ConversationPane } from "./conversation-pane";
import { taskDraftKey } from "./composer-draft";
import { ComposerScopeProvider, type ComposerScope } from "./composer-scope";
import type { DirectConversationView } from "./conversation-types";
import { ThreadLoadStatus, threadRootLoadOf } from "./thread-root-state";
import { OpenUnreadHintContext } from "./use-conversation-open";
import { useTaskConversation } from "./use-task-conversation";
import { useTaskEvents } from "./use-task-events";

type PaneProps = ComponentProps<typeof ConversationPane>;

export function TaskDiscussionPane({
  conversationId: known,
  board,
  changedAt,
  mentionables,
  ...pane
}: Omit<
  PaneProps,
  | "conversation"
  | "root"
  | "onSend"
  | "streamRead"
  | "onLoadOlder"
  | "onLoadNewer"
  | "onLoadMessageAround"
  | "onShowLatest"
  | "onReadLatest"
  | "onFollowingLatestChange"
> & {
  conversationId: string | undefined;
  board: { conversationId: string; number: number };
  changedAt: string | undefined;
  mentionables: DirectConversationView["mentionables"];
}) {
  const reply = useServerFn(replyToTask);
  const queryClient = useQueryClient();
  const {
    conversationId,
    made,
    pages,
    newest,
    seated,
    messages,
    hasNewer,
    hasOlder,
    unreadCount,
    firstUnreadMessageId,
    catchUp,
    ensure,
    loadOlder,
    loadNewer,
    loadMessageAround,
    showLatest,
    readLatest,
    setFollowingLatest,
  } = useTaskConversation({ known, board, jumpMessage: pane.jumpMessage });
  const timeline = useTaskEvents({
    conversationId,
    messages,
    hasNewer,
    loaded: pages.isSuccess,
    number: board.number,
    changedAt,
    members: mentionables,
  });
  const scope = useMemo<ComposerScope>(
    () => ({
      draftKey: taskDraftKey(board.conversationId, board.number),
      uploadTo: () => (conversationId && seated ? Promise.resolve(conversationId) : ensure()),
    }),
    [board.conversationId, board.number, conversationId, seated, ensure],
  );
  const unreadHint = useMemo(
    () =>
      conversationId && firstUnreadMessageId
        ? { conversationId, messageId: firstUnreadMessageId }
        : null,
    [conversationId, firstUnreadMessageId],
  );
  if (known && !made && !newest)
    return (
      <ThreadLoadStatus
        load={threadRootLoadOf(pages)}
        withRoot={false}
        onRetry={() => void pages.refetch()}
      />
    );
  return (
    <ComposerScopeProvider value={scope}>
      <ConversationTaskDemand
        conversationId={board.conversationId}
        channelName={pane.channelNames?.get(board.conversationId)}
        messages={messages}
        hasNewer={false}
        readWindow={false}
        openTaskNumber={undefined}
      />
      <OpenUnreadHintContext value={unreadHint}>
        <ConversationPane
          {...pane}
          inTaskPopup
          keepsReadCursor={Boolean(conversationId && seated)}
          onLoadMessageAround={loadMessageAround}
          onLoadOlder={loadOlder}
          onLoadNewer={loadNewer}
          onShowLatest={showLatest}
          onReadLatest={readLatest}
          onFollowingLatestChange={setFollowingLatest}
          conversation={{
            mentionables,
            ...newest,
            conversationId: conversationId ?? "",
            senderMemberId: newest?.senderMemberId ?? "",
            threads: undefined,
            messages: timeline,
            hasOlder,
            hasNewer,
            unreadCount,
          }}
          onSend={async (body, idempotencyKey, attachmentIds, options) => {
            await reply({
              data: {
                ...board,
                body,
                idempotencyKey,
                attachmentIds,
                mentions: options?.mentions ?? [],
              },
            });
            void queryClient.invalidateQueries({ queryKey: taskFollowQueryKey(board) });
            if (!conversationId || !seated) await ensure().catch(() => {});
            if (conversationId) await catchUp(conversationId);
            readLatest();
          }}
        />
      </OpenUnreadHintContext>
    </ComposerScopeProvider>
  );
}
