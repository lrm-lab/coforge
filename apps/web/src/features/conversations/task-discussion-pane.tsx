import { useMemo, type ComponentProps } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { replyToTask } from "#src/features/tasks/task-conversation.functions";
import { taskFollowQueryKey } from "#src/features/tasks/task-follow";
import { ConversationPane } from "./conversation-pane";
import { composerDraftKey } from "./composer-draft";
import { ComposerScopeProvider, type ComposerScope } from "./composer-scope";
import type { DirectConversationView } from "./conversation-types";
import { ThreadLoadStatus, threadRootLoadOf } from "./thread-root-state";
import { useTaskConversation } from "./use-task-conversation";

type PaneProps = ComponentProps<typeof ConversationPane>;

/**
 * A Task's own conversation under the Task in its popup, where a Task made from a message shows
 * that message's thread (`useTaskConversation` reads it). It draws no unread divider.
 *
 * Opening it makes nothing: a Task nobody has spoken about has no conversation, and a reader has
 * no seat in one until they write. A reply makes both on the server; a file, which is uploaded to
 * the conversation before the reply that carries it, makes them as it starts uploading. The draft
 * is kept under the Task, so it survives the conversation coming into being.
 */
export function TaskDiscussionPane({
  conversationId: known,
  board,
  mentionables,
  rootSlot,
  // The host conversation's own-message index and jumps say nothing about this one.
  onLoadOwnMessages: _ownMessages,
  onLoadMessageAround: _around,
  ...pane
}: Omit<PaneProps, "conversation" | "root" | "onSend" | "onLoadOlder" | "streamRead"> & {
  /** The Task's conversation; absent until someone has spoken there. */
  conversationId: string | undefined;
  /** The Task by its board and number, the address a reply goes to. */
  board: { conversationId: string; number: number };
  /** Whom a reply may mention before the conversation exists: the board's members. */
  mentionables: DirectConversationView["mentionables"];
  rootSlot: PaneProps["rootSlot"];
}) {
  const reply = useServerFn(replyToTask);
  const queryClient = useQueryClient();
  const { conversationId, made, pages, newest, seated, messages, catchUp, ensure } =
    useTaskConversation({ known, board });
  // A context, not composer props: the composer sits under `ConversationPane`, which is kept from
  // growing; the scope reaches it and its outbox without threading two props through the pane.
  const scope = useMemo<ComposerScope>(
    () => ({
      draftKey: composerDraftKey(`task:${board.conversationId}:${board.number}`),
      uploadTo: () => (conversationId && seated ? Promise.resolve(conversationId) : ensure()),
    }),
    [board.conversationId, board.number, conversationId, seated, ensure],
  );

  // A conversation the popup opened on loads under the Task; one made here stays an empty stream
  // while it is read, so the composer keeps the files on their way to it.
  if (known && !made && !newest)
    return (
      <>
        {rootSlot}
        <ThreadLoadStatus
          load={threadRootLoadOf(pages)}
          withRoot={false}
          onRetry={() => void pages.refetch()}
        />
      </>
    );
  return (
    <ComposerScopeProvider value={scope}>
      <ConversationPane
        {...pane}
        rootSlot={rootSlot}
        conversation={{
          mentionables,
          ...newest,
          // Before the conversation exists there is nothing to subscribe to or read.
          conversationId: conversationId ?? "",
          senderMemberId: newest?.senderMemberId ?? "",
          // A Task's conversation has no threads of its own.
          threads: undefined,
          messages,
          hasOlder: pages.hasNextPage,
          readThroughSequence: messages.at(-1)?.sequence,
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
          // The reply is taken; reading it back is the stream's business, never the send's
          // failure. A first reply made the conversation and the writer's seat, so `ensure` only
          // names them.
          // The writer follows the Task now.
          void queryClient.invalidateQueries({ queryKey: taskFollowQueryKey(board) });
          if (!conversationId || !seated) await ensure().catch(() => {});
          if (conversationId) await catchUp(conversationId);
        }}
        onLoadOlder={async () => {
          await pages.fetchNextPage();
        }}
      />
    </ComposerScopeProvider>
  );
}
